"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExportBundle, ExportJob, ModelEntry, VoiceProfile } from "@/lib/types";

const RUNNING = new Set(["queued", "copying", "pushing"]);

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function statusClass(status: string): string {
  if (status === "done") return "bg-green-50 text-green-700 border-green-200";
  if (status === "failed") return "bg-red-50 text-red-700 border-red-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

/**
 * Export a fine-tuned checkpoint as a self-contained voice service and, optionally, push it
 * to a server over SSH (docs/protocol.md §5). The remote install is two commands the job
 * prints; nothing here runs on the server.
 */
export default function ExportPanel() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [bundles, setBundles] = useState<ExportBundle[]>([]);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [push, setPush] = useState(true);
  const [host, setHost] = useState("");
  const [remotePath, setRemotePath] = useState("~/voice-service");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/export", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setBundles(data.bundles ?? []);
      setJobs(data.jobs ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    fetch("/api/models", { cache: "no-store" }).then((r) => r.json()).then((list: ModelEntry[]) => {
      const tuned = list.filter((m) => m.kind === "finetuned").sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      setModels(tuned);
      if (tuned[0]) { setModelId(tuned[0].id); setName(`${tuned[0].name}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`); }
    }).catch(() => {});
    fetch("/api/tts/profiles", { cache: "no-store" }).then((r) => r.json()).then((list: VoiceProfile[]) => {
      const ready = list.filter((p) => p.promptAudioPath);
      setProfiles(ready);
      setSelected(new Set(ready.map((p) => p.id)));
    }).catch(() => {});
    void refresh();
  }, [refresh]);

  const running = jobs.some((j) => RUNNING.has(j.status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const start = async () => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, name: name.trim() || undefined, profileIds: [...selected], push: push ? { host: host.trim(), path: remotePath.trim() } : undefined }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const model = models.find((m) => m.id === modelId);
  const remoteRoot = `${remotePath.replace(/\/$/, "")}/${name || "<name>"}`;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Export</h1>
        <p className="text-sm text-gray-600 mt-1">
          Package a fine-tuned checkpoint with its reference clips and this backend as a service another machine can run, so the
          digital human and the motion arena synthesize there and this card is free.
        </p>
      </header>

      <section className="rounded-xl border bg-white p-5 space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <label className="text-sm">
            <span className="text-gray-600">Checkpoint</span>
            <select value={modelId} onChange={(e) => { setModelId(e.target.value); const m = models.find((x) => x.id === e.target.value); if (m) setName(`${m.name}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`); }}
              className="mt-1 w-full border rounded-lg px-3 py-2 bg-white">
              {models.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.stage} · {m.createdAt?.slice(0, 10)}{m.active ? " · loaded" : ""}</option>)}
              {!models.length && <option value="">no fine-tuned checkpoint yet</option>}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-gray-600">Bundle name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" />
          </label>
        </div>
        <div className="text-sm">
          <span className="text-gray-600">Reference profiles to include</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {profiles.map((p) => (
              <label key={p.id} className={`px-3 py-1 rounded-full border text-xs cursor-pointer ${selected.has(p.id) ? "bg-gray-900 text-white border-gray-900" : "bg-white"}`}>
                <input type="checkbox" className="hidden" checked={selected.has(p.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                {p.emotion} · {p.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push to a server over SSH</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} disabled={!push} placeholder="user@host" className="border rounded-lg px-3 py-1.5 w-44 disabled:opacity-50" />
          <input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} disabled={!push} placeholder="~/voice-service" className="border rounded-lg px-3 py-1.5 w-52 disabled:opacity-50" />
          <button onClick={start} disabled={busy || running || !modelId || !selected.size} className="px-4 py-2 rounded-lg bg-gray-900 text-white disabled:opacity-50">
            {push ? "Export and push" : "Export"}
          </button>
        </div>
        {model && (
          <p className="text-xs text-gray-500">
            The bundle copies every model file (about 9 GB of base weights plus the fine-tuned LLM) so it stands alone, with no symlinks into this machine&apos;s caches.
            {push && <> On the server: <code>bash {remoteRoot}/serve/install.sh</code> then <code>bash {remoteRoot}/serve/run.sh</code>, or the systemd unit in <code>serve/README.md</code>.</>}
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {jobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Export jobs</h2>
          {jobs.map((j) => (
            <div key={j.id} className={`rounded-xl border p-4 text-sm ${statusClass(j.status)}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{j.name}</span>
                <span className="uppercase text-xs">{j.status}{j.step ? ` · ${j.step}` : ""}</span>
                {j.bytesTotal > 0 && <span className="text-xs">{gb(j.bytesCopied)} / {gb(j.bytesTotal)}</span>}
                {j.push?.host && <span className="text-xs">→ {j.push.host}:{j.push.path ?? "~/voice-service"}/{j.name}</span>}
              </div>
              {j.error && <p className="mt-1">{j.error}</p>}
              <pre className="mt-2 max-h-48 overflow-auto text-xs bg-white/60 rounded p-2 whitespace-pre-wrap">{j.logTail.join("\n")}</pre>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">Bundles on this machine (exports/, ignored by git)</h2>
        {bundles.length ? (
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 text-left"><tr><th className="py-1">name</th><th>checkpoint</th><th>profiles</th><th>size</th><th>created</th></tr></thead>
            <tbody>{bundles.map((b) => (
              <tr key={b.name} className="border-t"><td className="py-1 font-medium">{b.name}</td><td>{b.model}</td><td>{b.profiles}</td><td>{gb(b.bytes)}</td><td>{b.createdAt?.slice(0, 19).replace("T", " ")}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="text-sm text-gray-400">No bundle yet.</p>}
      </section>
    </div>
  );
}
