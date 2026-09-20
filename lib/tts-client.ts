import type { TTSMode, CandidateMetrics } from "./types";

/** CosyVoice backend (backend/server.py). Port 8010 because 8000 is taken on this machine. */
export const TTS_ENDPOINT = process.env.TTS_ENDPOINT || "http://127.0.0.1:8010";

export interface BackendTTSParams {
  text: string;
  promptAudioAbsPath: string;
  promptText: string;
  instruct: string;
  speed: number;
  seed?: number;
  mode?: TTSMode;
  trimBreath?: boolean;
}

export interface BackendTTSResult {
  audioBuffer: Buffer;
  duration: number;
  elapsedSeconds: number;
  seed: number;
  mode: TTSMode;
  model: string;
}

export async function generateSpeech(params: BackendTTSParams): Promise<BackendTTSResult> {
  const body = {
    text: params.text,
    reference_audio: params.promptAudioAbsPath,
    prompt_text: params.promptText,
    instruct: params.instruct,
    speed: params.speed,
    seed: params.seed ?? null,
    mode: params.mode ?? "auto",
    trim_breath: params.trimBreath ?? true,
  };

  const response = await fetch(`${TTS_ENDPOINT}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TTS backend error (${response.status}): ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const h = response.headers;
  return {
    audioBuffer,
    duration: parseFloat(h.get("x-audio-duration") || "0"),
    elapsedSeconds: parseFloat(h.get("x-elapsed-seconds") || "0"),
    seed: parseInt(h.get("x-seed") || "0", 10),
    mode: (h.get("x-mode") || "auto") as TTSMode,
    model: h.get("x-model") || "unknown",
  };
}

export interface PrepareResult {
  prompt_wav: string;
  transcript: string;
  duration: number;
  language: string;
}

/** Turn any uploaded recording into a clean prompt wav plus transcript. */
export async function prepareReference(params: {
  sourceAbsPath: string;
  outAbsPath: string;
  transcript?: string;
  language?: string;
  maxSeconds?: number;
  /** false = source is already a clean prompt; only convert, no denoise or run selection. */
  process?: boolean;
}): Promise<PrepareResult> {
  const response = await fetch(`${TTS_ENDPOINT}/v1/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_audio: params.sourceAbsPath,
      out_wav: params.outAbsPath,
      transcript: params.transcript ?? null,
      language: params.language ?? "auto",
      max_seconds: params.maxSeconds ?? 12,
      process: params.process ?? true,
    }),
  });
  if (!response.ok) {
    throw new Error(`TTS backend prepare error (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as PrepareResult;
}

export async function backendHealth(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${TTS_ENDPOINT}/health`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function chunkText(text: string, maxChars: number = 500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
}

/** Objective metrics for one wav (docs/protocol.md §2). Never throws: nulls on failure. */
export async function computeMetrics(params: {
  wavAbsPath: string;
  text: string;
  referenceAbsPath?: string;
  language?: string;
}): Promise<CandidateMetrics> {
  const empty: CandidateMetrics = { wer: null, speakerSimilarity: null, reverbTailDb: null, duration: 0 };
  try {
    const r = await fetch(`${TTS_ENDPOINT}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wav_path: params.wavAbsPath,
        text: params.text,
        reference_wav: params.referenceAbsPath ?? null,
        language: params.language ?? "en",
      }),
    });
    if (!r.ok) return empty;
    const j = (await r.json()) as {
      wer: number | null;
      transcript?: string;
      speaker_similarity: number | null;
      reverb_tail_db: number | null;
      duration: number;
    };
    return {
      wer: j.wer ?? null,
      transcript: j.transcript,
      speakerSimilarity: j.speaker_similarity ?? null,
      reverbTailDb: j.reverb_tail_db ?? null,
      duration: j.duration ?? 0,
    };
  } catch {
    return empty;
  }
}
