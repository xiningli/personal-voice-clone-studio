import { NextRequest } from "next/server";
import path from "path";
import { getTakes, updateTake, wavPath, rebuildProfilePrompt, DEFAULT_SPEAKER, assertSafeId, takeBelongs } from "@/lib/corpus";
import { getProfiles, getProfile, saveProfile } from "@/lib/storage";
import { qcTake } from "@/lib/qc-client";
import type { Take } from "@/lib/types";

export const maxDuration = 600;

/**
 * Re-run QC on stored takes from their raw uploads, without re-recording. Use it after the
 * thresholds or the estimators change: every verdict, tier and metric is recomputed with
 * the current rules, and the affected profiles' prompts are rebuilt. Deterministic and
 * logged in the response, so it is an honest operation on the corpus.
 * Body: { speaker?: string, profileId?: string, onlyRejected?: boolean }
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { speaker?: string; profileId?: string; onlyRejected?: boolean };
  const speakerId = assertSafeId(body.speaker || DEFAULT_SPEAKER, "speaker id");
  const scope = body.profileId ? await getProfile(body.profileId) : null;
  const takes = (await getTakes(speakerId)).filter(
    (t) => (!body.profileId || (scope ? takeBelongs(t, scope) : t.profileId === body.profileId)) && (!body.onlyRejected || t.verdict === "reject")
  );
  const root = process.cwd();
  const changes: { id: string; text: string; from: string; to: string; reasons: string[] }[] = [];
  let unchanged = 0;
  let errors = 0;
  const touched = new Set<string>();
  for (const t of takes) {
    const src = path.isAbsolute(t.sourcePath) ? t.sourcePath : path.join(root, t.sourcePath);
    try {
      const qc = await qcTake({
        sourceAbsPath: src,
        outAbsPath: wavPath(speakerId, t.id),
        text: t.text,
        language: t.language === "zh" ? "zh" : "en",
        emotion: t.emotion,
      });
      const before = t.verdict === "accept" ? (t.quality ?? "clean") : "reject";
      const after = qc.verdict === "accept" ? qc.quality : "reject";
      const next: Take = {
        ...t,
        metrics: qc.metrics,
        verdict: qc.verdict,
        reasons: qc.reasons,
        quality: qc.verdict === "accept" ? qc.quality : undefined,
        warnings: qc.warnings?.length ? qc.warnings : undefined,
      };
      await updateTake(next);
      if (before !== after) changes.push({ id: t.id, text: t.text, from: before, to: after, reasons: qc.reasons });
      else unchanged += 1;
      if (t.profileId) touched.add(t.profileId);
    } catch {
      errors += 1;
    }
  }
  const profiles = await getProfiles();
  for (const p of profiles) {
    if (!touched.has(p.id) && !takes.some((t) => takeBelongs(t, p))) continue;
    const derived = await rebuildProfilePrompt(p, speakerId);
    await saveProfile({ ...p, ...derived, updatedAt: new Date().toISOString() });
  }
  const all = await getTakes(speakerId);
  return Response.json({
    requalified: takes.length,
    changed: changes.length,
    unchanged,
    errors,
    accepted: all.filter((t) => t.verdict === "accept").length,
    borderline: all.filter((t) => t.verdict === "accept" && t.quality === "borderline").length,
    rejected: all.filter((t) => t.verdict === "reject").length,
    changes,
  });
}
