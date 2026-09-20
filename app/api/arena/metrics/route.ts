import { getArenaRounds, saveArenaRound, getProfile, publicPathToAbs } from "@/lib/storage";
import { computeMetrics } from "@/lib/tts-client";

export const maxDuration = 600;

/**
 * POST /api/arena/metrics — backfill objective metrics on candidates that lack them
 * (rounds made while the backend had no /v1/metrics, or after a metrics failure).
 * Body: { force?: boolean } recomputes every candidate.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const rounds = await getArenaRounds();
  let updated = 0;
  let skipped = 0;
  for (const round of rounds) {
    const profile = await getProfile(round.profileId);
    let dirty = false;
    for (const c of round.candidates) {
      const missing = !c.metrics || (c.metrics.wer === null && c.metrics.speakerSimilarity === null && c.metrics.reverbTailDb === null);
      if (!body.force && !missing) {
        skipped += 1;
        continue;
      }
      const metrics = await computeMetrics({
        wavAbsPath: publicPathToAbs(c.audioPath),
        text: round.text,
        referenceAbsPath: profile?.promptAudioPath ? publicPathToAbs(profile.promptAudioPath) : undefined,
        language: profile?.language === "zh" ? "zh" : "en",
      });
      const got = metrics.wer !== null || metrics.speakerSimilarity !== null || metrics.reverbTailDb !== null;
      if (got) {
        c.metrics = metrics;
        dirty = true;
        updated += 1;
      } else {
        skipped += 1;
      }
    }
    if (dirty) await saveArenaRound(round);
  }
  return Response.json({ updated, skipped, rounds: rounds.length });
}
