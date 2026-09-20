import { NextRequest } from "next/server";
import { getProfile, getArenaRounds } from "@/lib/storage";
import { createRound, RoundGenerationError } from "@/lib/arena-server";
import type { ArenaVariant } from "@/lib/types";

export const maxDuration = 600;

export async function GET() {
  const rounds = await getArenaRounds();
  rounds.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Response.json(rounds);
}

function isVariant(v: unknown): v is ArenaVariant {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.instruct === "string" &&
    typeof o.speed === "number" &&
    o.speed >= 0.5 &&
    o.speed <= 2 &&
    (o.seed === undefined || o.seed === null || typeof o.seed === "number") &&
    (o.model === undefined || o.model === null || typeof o.model === "string")
  );
}

/** Generate one candidate per variant, then hide their order behind blind labels. */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { profileId, text, variants } = body as { profileId?: string; text?: string; variants?: unknown };

  if (!profileId || !text?.trim()) {
    return Response.json({ error: "profileId and text are required" }, { status: 400 });
  }
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 6 || !variants.every(isVariant)) {
    return Response.json({ error: "variants must be 2-6 entries of {instruct, speed, seed?}" }, { status: 400 });
  }

  const profile = await getProfile(profileId);
  if (!profile) {
    return Response.json({ error: "Voice profile not found" }, { status: 404 });
  }
  if (!profile.promptAudioPath) {
    return Response.json(
      { error: "This profile has no prepared prompt audio. Re-create it on the Voice Profiles page." },
      { status: 409 }
    );
  }

  try {
    const round = await createRound(profile, text, variants);
    return Response.json(round, { status: 201 });
  } catch (err) {
    if (err instanceof RoundGenerationError) {
      return Response.json({ error: err.message, candidates: err.made }, { status: 502 });
    }
    throw err;
  }
}
