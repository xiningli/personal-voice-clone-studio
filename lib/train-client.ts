import { TTS_ENDPOINT } from "./tts-client";
import type { TrainingJob, ModelEntry } from "./types";

async function backend<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TTS_ENDPOINT}${path}`, { cache: "no-store", ...init });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text error */
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body && "detail" in body ? (body as { detail: unknown }).detail : body;
    throw new BackendError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

export class BackendError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface SFTParams {
  name: string;
  speaker_id: string;
  dataset_dir: string;
  base_model?: string;
  epochs?: number;
  lr?: number;
  heldout_fraction?: number;
  seed?: number;
  train_flow?: boolean;
  include_borderline?: boolean;
  average_num?: number;
}

export interface DPOParams {
  name: string;
  pairs_file: string;
  base_model: string;
  ref_model?: string;
  beta?: number;
  epochs?: number;
  lr?: number;
  heldout_fraction?: number;
  seed?: number;
  force?: boolean;
}

export const startSFT = (p: SFTParams) =>
  backend<TrainingJob>("/v1/train/sft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
export const startDPO = (p: DPOParams) =>
  backend<TrainingJob>("/v1/train/dpo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
export const listJobs = () => backend<TrainingJob[]>("/v1/train/jobs");
export const getJob = (id: string) => backend<TrainingJob>(`/v1/train/jobs/${encodeURIComponent(id)}`);
export const cancelJob = (id: string) => backend<TrainingJob>(`/v1/train/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const listModels = () => backend<ModelEntry[]>("/v1/models");
export const selectModel = (id: string) =>
  backend<{ active: string; ready: boolean; load_seconds: number }>("/v1/models/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });

/** Turn a backend failure into a JSON response with the same status. */
export function errorResponse(err: unknown): Response {
  if (err instanceof BackendError) return Response.json({ error: err.message }, { status: err.status });
  const msg = err instanceof Error ? err.message : String(err);
  const unreachable = /ECONNREFUSED|fetch failed/i.test(msg);
  return Response.json({ error: unreachable ? "TTS backend unreachable; start it with bash backend/run.sh" : msg }, { status: 502 });
}
