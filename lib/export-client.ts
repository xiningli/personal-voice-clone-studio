import { TTS_ENDPOINT } from "./tts-client";
import type { ExportBundle, ExportJob } from "./types";

async function backend<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TTS_ENDPOINT}${path}`, { cache: "no-store", ...init });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  if (!res.ok) {
    const detail = typeof body === "object" && body && "detail" in body ? (body as { detail: unknown }).detail : body;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

export const listBundles = () => backend<ExportBundle[]>("/v1/export/bundles");
export const listExportJobs = () => backend<ExportJob[]>("/v1/export/jobs");
export const getExportJob = (id: string) => backend<ExportJob>(`/v1/export/jobs/${encodeURIComponent(id)}`);
export const startExport = (body: { model_id: string; name?: string; profile_ids?: string[]; push?: { host: string; path?: string } }) =>
  backend<ExportJob>("/v1/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
