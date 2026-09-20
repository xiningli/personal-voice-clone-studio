import { TTS_ENDPOINT } from "./tts-client";
import type { TakeMetrics, TakeVerdict, TakeQuality } from "./types";

export interface QCResult {
  metrics: TakeMetrics;
  verdict: TakeVerdict;
  reasons: string[];
  quality: TakeQuality;
  warnings: string[];
  thresholds: Record<string, number>;
}

/** Decode, trim, write and measure one corpus take through the backend (POST /v1/qc). */
export async function qcTake(params: {
  sourceAbsPath: string;
  outAbsPath: string;
  text: string;
  language?: string;
  emotion?: string;
}): Promise<QCResult> {
  const response = await fetch(`${TTS_ENDPOINT}/v1/qc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_audio: params.sourceAbsPath,
      out_wav: params.outAbsPath,
      text: params.text,
      language: params.language ?? "en",
      emotion: params.emotion ?? null,
    }),
  });
  if (!response.ok) {
    throw new Error(`QC backend error (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as QCResult;
}
