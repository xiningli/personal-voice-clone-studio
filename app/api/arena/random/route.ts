import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getProfile, getProfiles, getPresets, getArenaRounds, getArenaVotes } from "@/lib/storage";
import { createRound, RoundGenerationError, type PremadeCandidate } from "@/lib/arena-server";
import { LINE_BANK, pickLine, sampleBalanced } from "@/lib/arena-bank";
import type { ArenaRound, ArenaVariant, Take, TrialType, VoiceProfile } from "@/lib/types";

export const maxDuration = 600;

/** Trial mix from docs/protocol.md §2. Anchors need a real recording; otherwise their share goes to test.
 *  Duels are never drawn at random: they are requested explicitly with `body.duel`. */
export const TRIAL_MIX: Record<Exclude<TrialType, "duel">, number> = { test: 0.55, seed: 0.25, repeat: 0.15, anchor: 0.05 };
const SPEAKER_ID = "owner";

function drawTrial(canRepeat: boolean, canAnchor: boolean): Exclude<TrialType, "duel"> {
  const r = Math.random();
  if (r < TRIAL_MIX.anchor && canAnchor) return "anchor";
  if (r < TRIAL_MIX.anchor + TRIAL_MIX.repeat && canRepeat) return "repeat";
  if (r < TRIAL_MIX.anchor + TRIAL_MIX.repeat + TRIAL_MIX.seed) return "seed";
  return "test";
}

async function acceptedTakes(): Promise<Take[]> {
  const file = path.join(process.cwd(), "datasets", SPEAKER_ID, "takes.jsonl");
  try {
    const text = await fs.readFile(file, "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Take)
      .filter((t) => t.verdict === "accept");
  } catch {
    return [];
  }
}

function takeAbsPath(t: Take): string {
  return path.isAbsolute(t.audioPath) ? t.audioPath : path.join(process.cwd(), t.audioPath);
}

/**
 * Sample a round instead of typing one (docs/protocol.md §2).
 *
 * Body: { category?: "any" | <bank id>, n?: 2-4, profileId?: string | "random", trial?: TrialType,
 *         repeatOf?: string (force re-serving one specific decided round; testing / "re-serve this pair") }
 *
 * test   — a line from the bank, `n` distinct instructions drawn from the English presets
 *          (pure clone included) with inverse-frequency weighting, one shared seed.
 * repeat — a previously decided 2-candidate round of the current model re-generated with the
 *          same instructs/speeds/seed (bit-identical audio), reshuffled under fresh labels.
 * anchor — an accepted real recording of a bank line against one synthesized candidate.
 * duel   — body.duel = { models: [a, b] }: one line, ONE instruction (inverse-frequency over
 *          previous duels), one seed, two candidates that differ only in the checkpoint.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    category?: string;
    n?: number;
    profileId?: string;
    trial?: TrialType;
    repeatOf?: string;
    duel?: { models?: unknown };
  };
  const category = body.category || "any";
  const n = Math.min(4, Math.max(2, Math.round(Number(body.n) || 2)));

  const profiles = (await getProfiles()).filter((p) => p.promptAudioPath);
  if (profiles.length === 0) {
    return Response.json({ error: "No prepared voice profile. Create one on the Voice Profiles page." }, { status: 409 });
  }
  const pickProfile = async (): Promise<VoiceProfile | null> =>
    !body.profileId || body.profileId === "random"
      ? profiles[Math.floor(Math.random() * profiles.length)]
      : await getProfile(body.profileId);

  const presets = (await getPresets()).filter((p) => p.language === "en" || p.language === "any");
  const pool: ArenaVariant[] = presets.map((p) => ({ instruct: p.instruct, speed: p.speed, presetId: p.id }));
  if (!pool.some((v) => v.instruct === "")) pool.unshift({ instruct: "", speed: 1.0, presetId: "neutral-clone" });

  const [rounds, votes] = await Promise.all([getArenaRounds(), getArenaVotes()]);
  const appearances = new Map<string, number>();
  for (const r of rounds) for (const c of r.candidates) appearances.set(c.instruct, (appearances.get(c.instruct) ?? 0) + 1);

  // Candidates for a repeat: decided, exactly two synthesized candidates, made by the model
  // currently loaded (the newest round's model is the best proxy we have without a health call).
  const currentModel = [...rounds].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.model;
  const votedRoundIds = new Set(votes.filter((v) => v.winnerId).map((v) => v.roundId));
  const repeatable = rounds.filter(
    (r) =>
      (r.trial ?? "test") === "test" &&
      r.candidates.length === 2 &&
      r.candidates.every((c) => !c.isRecording) &&
      votedRoundIds.has(r.id) &&
      (!currentModel || r.model === currentModel)
  );

  const takes = await acceptedTakes();
  const bankLines = new Map<string, string>(); // text -> category id
  for (const c of LINE_BANK) for (const l of c.lines) bankLines.set(l.trim(), c.id);
  const anchorTakes = takes.filter((t) => bankLines.has(t.text.trim()));

  const forced = body.repeatOf ? rounds.find((r) => r.id === body.repeatOf && r.candidates.length === 2) : undefined;
  const duelModels = Array.isArray(body.duel?.models) ? (body.duel!.models as unknown[]).filter((m): m is string => typeof m === "string" && m.length > 0) : [];
  if (body.duel && (duelModels.length !== 2 || duelModels[0] === duelModels[1])) {
    return Response.json({ error: "duel.models must be exactly two distinct model ids" }, { status: 400 });
  }
  let trial: TrialType = duelModels.length === 2 ? "duel" : forced ? "repeat" : body.trial ?? drawTrial(repeatable.length > 0, anchorTakes.length > 0);
  if (trial === "repeat" && !forced && repeatable.length === 0) trial = "test";
  if (trial === "anchor" && anchorTakes.length === 0) trial = "test";
  if (trial === "duel" && duelModels.length !== 2) trial = "test";

  try {
    let round: ArenaRound;
    if (trial === "duel") {
      const profile = await pickProfile();
      if (!profile || !profile.promptAudioPath) {
        return Response.json({ error: "Voice profile not found or not prepared" }, { status: 404 });
      }
      // Balance instructions across previous duels only, so the duel bank fills evenly
      // regardless of how many instruction-vs-instruction rounds exist.
      const duelAppearances = new Map<string, number>();
      for (const r of rounds) {
        if (r.trial !== "duel") continue;
        for (const c of r.candidates) duelAppearances.set(c.instruct, (duelAppearances.get(c.instruct) ?? 0) + 1);
      }
      const [base] = sampleBalanced(pool, (v) => duelAppearances.get(v.instruct) ?? 0, 1);
      const seed = Math.floor(Math.random() * 2_000_000_000);
      const variants: ArenaVariant[] = duelModels.map((m) => ({ ...base, seed, model: m }));
      const { category: cat, text } = pickLine(category);
      round = await createRound(profile, text, variants, {
        category: cat.id,
        sampled: true,
        trial: "duel",
        model: "duel",
        models: duelModels,
      });
    } else if (trial === "repeat") {
      const orig = forced ?? repeatable[Math.floor(Math.random() * repeatable.length)];
      const profile = await getProfile(orig.profileId);
      if (!profile || !profile.promptAudioPath) {
        return Response.json({ error: "The profile of the round to repeat no longer exists" }, { status: 409 });
      }
      const variants: ArenaVariant[] = orig.candidates.map((c) => ({
        instruct: c.instruct,
        speed: c.speed,
        seed: c.seed,
        presetId: c.presetId,
      }));
      round = await createRound(profile, orig.text, variants, {
        category: orig.category,
        sampled: true,
        trial: "repeat",
        repeatOf: orig.id,
      });
    } else if (trial === "anchor") {
      const take = anchorTakes[Math.floor(Math.random() * anchorTakes.length)];
      const profile = await pickProfile();
      if (!profile || !profile.promptAudioPath) {
        return Response.json({ error: "Voice profile not found or not prepared" }, { status: 404 });
      }
      const seed = Math.floor(Math.random() * 2_000_000_000);
      const variants = sampleBalanced(pool, (v) => appearances.get(v.instruct) ?? 0, 1).map((v) => ({ ...v, seed }));
      const premade: PremadeCandidate[] = [
        { absPath: takeAbsPath(take), instruct: "(recording)", takeId: take.id, isRecording: true },
      ];
      round = await createRound(
        profile,
        take.text,
        variants,
        { category: bankLines.get(take.text.trim()), sampled: true, trial: "anchor" },
        premade
      );
    } else if (trial === "seed") {
      // Same text, same instruction, two seeds: the rater's choice is a preference between
      // two samples of one prompt, which is exactly what DPO consumes.
      const profile = await pickProfile();
      if (!profile || !profile.promptAudioPath) {
        return Response.json({ error: "Voice profile not found or not prepared" }, { status: 404 });
      }
      const seedAppearances = new Map<string, number>();
      for (const r of rounds) if (r.trial === "seed") for (const c of r.candidates) seedAppearances.set(c.instruct, (seedAppearances.get(c.instruct) ?? 0) + 1);
      const [base] = sampleBalanced(pool, (v) => seedAppearances.get(v.instruct) ?? 0, 1);
      const s1 = Math.floor(Math.random() * 2_000_000_000);
      let s2 = Math.floor(Math.random() * 2_000_000_000);
      if (s2 === s1) s2 = (s1 + 1) % 2_000_000_000;
      const variants = [{ ...base, seed: s1 }, { ...base, seed: s2 }];
      const { category: cat, text } = pickLine(category);
      round = await createRound(profile, text, variants, { category: cat.id, sampled: true, trial: "seed" });
    } else {
      const profile = await pickProfile();
      if (!profile || !profile.promptAudioPath) {
        return Response.json({ error: "Voice profile not found or not prepared" }, { status: 404 });
      }
      if (pool.length < n) {
        return Response.json({ error: `Only ${pool.length} English instructions available; need ${n}` }, { status: 409 });
      }
      const seed = Math.floor(Math.random() * 2_000_000_000);
      const variants = sampleBalanced(pool, (v) => appearances.get(v.instruct) ?? 0, n).map((v) => ({ ...v, seed }));
      const { category: cat, text } = pickLine(category);
      round = await createRound(profile, text, variants, { category: cat.id, sampled: true, trial: "test" });
    }
    return Response.json(round, { status: 201 });
  } catch (err) {
    if (err instanceof RoundGenerationError) {
      return Response.json({ error: err.message, candidates: err.made }, { status: 502 });
    }
    throw err;
  }
}
