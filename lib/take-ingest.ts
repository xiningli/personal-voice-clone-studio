import fs from "fs/promises";
import { v4 as uuid } from "uuid";
import { appendTake, saveRaw, wavPath, toRepoRelative, DEFAULT_SPEAKER, assertSafeId } from "./corpus";
import { qcTake } from "./qc-client";
import type { Take, Language } from "./types";

/**
 * Store an uploaded recording as a take: raw bytes → backend QC (decode, trim, measure,
 * transcribe) → take record with verdict and reasons. A take that never got measured is
 * deleted again so no orphan uploads accumulate. Shared by the session route and by
 * "Upload a clip" on a profile.
 */
export async function ingestTake(params: {
  file: File;
  promptId: string;
  text: string;
  emotion: string;
  language: Language;
  sessionId: string;
  profileId?: string;
  speakerId?: string;
}): Promise<Take> {
  const speakerId = params.speakerId ?? DEFAULT_SPEAKER;
  assertSafeId(speakerId, "speaker id");
  assertSafeId(params.promptId, "prompt id");
  const id = uuid();
  const buffer = Buffer.from(await params.file.arrayBuffer());
  const isRiff = buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF";
  const isWebm = buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  const ext = isRiff ? "wav" : isWebm ? "webm" : (params.file.name.split(".").pop() || "bin").toLowerCase();
  const rawAbs = await saveRaw(speakerId, id, ext, buffer);
  const outAbs = wavPath(speakerId, id);

  let qc;
  try {
    qc = await qcTake({
      sourceAbsPath: rawAbs,
      outAbsPath: outAbs,
      text: params.text,
      language: params.language === "zh" ? "zh" : "en",
      emotion: params.emotion,
    });
  } catch (err) {
    await fs.unlink(rawAbs).catch(() => undefined);
    throw err;
  }

  const take: Take = {
    id,
    speakerId,
    sessionId: params.sessionId,
    promptId: params.promptId,
    profileId: params.profileId,
    text: params.text,
    emotion: params.emotion,
    language: params.language,
    audioPath: toRepoRelative(outAbs),
    sourcePath: toRepoRelative(rawAbs),
    metrics: qc.metrics,
    verdict: qc.verdict,
    reasons: qc.reasons,
    quality: qc.verdict === "accept" ? qc.quality : undefined,
    warnings: qc.warnings?.length ? qc.warnings : undefined,
    createdAt: new Date().toISOString(),
  };
  await appendTake(take);
  return take;
}
