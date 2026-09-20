import { v4 as uuid } from "uuid";
import { publicPathToAbs, saveArenaFile, saveArenaRound } from "@/lib/storage";
import { generateSpeech, computeMetrics, backendHealth } from "@/lib/tts-client";
import { selectModel } from "@/lib/train-client";
import fs from "fs/promises";
import { LABELS } from "@/lib/arena";
import type { ArenaCandidate, ArenaRound, ArenaVariant, VoiceProfile } from "@/lib/types";

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A candidate supplied as an existing wav (an anchor recording) instead of synthesized. */
export interface PremadeCandidate {
  absPath: string;
  instruct: string;
  takeId?: string;
  isRecording?: boolean;
}

export class RoundGenerationError extends Error {
  constructor(message: string, public readonly made: Omit<ArenaCandidate, "label">[]) {
    super(message);
  }
}

/** Generate one candidate per variant (sequentially, one GPU), shuffle, label blind, persist. */
export async function createRound(
  profile: VoiceProfile,
  text: string,
  variants: ArenaVariant[],
  extra: Pick<ArenaRound, "category" | "sampled" | "trial" | "repeatOf" | "models" | "model"> = {},
  premade: PremadeCandidate[] = []
): Promise<ArenaRound> {
  const roundId = uuid();
  const made: Omit<ArenaCandidate, "label">[] = [];
  let model = "unknown";
  // Duel rounds pin a model per variant. Remember what was loaded so the round leaves the
  // backend as it found it, and only switch when the variant asks for something else.
  const wantsSwitch = variants.some((v) => v.model);
  const startModel = wantsSwitch ? ((await backendHealth())?.model as string | undefined) ?? null : null;
  let current = startModel;
  try {
    for (const p of premade) {
      const candidateId = uuid();
      const buffer = await fs.readFile(p.absPath);
      const audioPath = await saveArenaFile(buffer, `arena-${roundId}-${candidateId}.wav`);
      const metrics = await computeMetrics({
        wavAbsPath: publicPathToAbs(audioPath),
        text: text.trim(),
        referenceAbsPath: publicPathToAbs(profile.promptAudioPath),
        language: profile.language === "auto" ? "en" : profile.language,
      });
      made.push({
        id: candidateId,
        instruct: p.instruct,
        speed: 1,
        seed: 0,
        audioPath,
        duration: metrics.duration,
        elapsedSeconds: 0,
        metrics,
        isRecording: p.isRecording ?? true,
        takeId: p.takeId,
      });
    }
    for (const variant of variants) {
      const candidateId = uuid();
      if (variant.model && variant.model !== current) {
        await selectModel(variant.model);
        current = variant.model;
      }
      const out = await generateSpeech({
        text: text.trim(),
        promptAudioAbsPath: publicPathToAbs(profile.promptAudioPath),
        promptText: profile.promptText,
        instruct: variant.instruct,
        speed: variant.speed,
        seed: variant.seed ?? undefined,
        mode: "auto",
      });
      model = out.model;
      const audioPath = await saveArenaFile(out.audioBuffer, `arena-${roundId}-${candidateId}.wav`);
      const metrics = await computeMetrics({
        wavAbsPath: publicPathToAbs(audioPath),
        text: text.trim(),
        referenceAbsPath: publicPathToAbs(profile.promptAudioPath),
        language: profile.language === "auto" ? "en" : profile.language,
      });
      made.push({
        metrics,
        id: candidateId,
        instruct: variant.instruct,
        speed: variant.speed,
        presetId: variant.presetId,
        seed: out.seed,
        audioPath,
        duration: out.duration,
        elapsedSeconds: out.elapsedSeconds,
        model: out.model,
      });
    }
  } catch (err) {
    throw new RoundGenerationError(err instanceof Error ? err.message : "Generation failed", made);
  } finally {
    if (wantsSwitch && startModel && current !== startModel) {
      await selectModel(startModel).catch(() => undefined);
    }
  }
  const candidates: ArenaCandidate[] = shuffle(made).map((c, i) => ({ ...c, label: LABELS[i] }));
  const round: ArenaRound = {
    id: roundId,
    createdAt: new Date().toISOString(),
    profileId: profile.id,
    text: text.trim(),
    candidates,
    model,
    ...extra,
  };
  await saveArenaRound(round);
  return round;
}
