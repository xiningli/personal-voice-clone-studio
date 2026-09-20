"use client";

import { useCallback, useEffect, useState } from "react";
import type { CorpusStats, ModelEntry, TrainingJob } from "@/lib/types";

interface ArenaStats {
  model: string;
  models: string[];
  totalRounds: number;
  totalVotes: number;
}

const RUNNING = new Set(["queued", "preparing", "training", "averaging", "assembling"]);
const DPO_MIN_PAIRS = 200;

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function statusClass(status: string): string {
  if (status === "done") return "bg-green-50 text-green-700 border-green-200";
  if (status === "failed") return "bg-red-50 text-red-700 border-red-200";
  if (status === "cancelled") return "bg-gray-100 text-gray-600 border-gray-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

export default function TrainPanel() {
  const [corpus, setCorpus] = useState<CorpusStats | null | "unavailable">(null);
  const [arena, setArena] = useState<ArenaStats | null>(null);
  const [pairCounts, setPairCounts] = useState<Record<string, number>>({});
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Stage A form
  const [sftName, setSftName] = useState("owner-sft-v1");
  const [epochs, setEpochs] = useState(10);
  const [lr, setLr] = useState("1e-5");
  const [heldout, setHeldout] = useState(0.05);
  const [seed, setSeed] = useState(1234);
  const [trainFlow, setTrainFlow] = useState(false);
  const [includeBorderline, setIncludeBorderline] = useState(false);
  const [sftBase, setSftBase] = useState("");

  // Stage B form
  const [dpoName, setDpoName] = useState("owner-dpo-v1");
  const [dpoBase, setDpoBase] = useState("");
  const [dpoEpochs, setDpoEpochs] = useState(3);
  const [dpoForce, setDpoForce] = useState(false);

  const load = useCallback(async () => {
    const [c, a, m, j] = await Promise.allSettled([
      fetch("/api/corpus/stats", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/arena/stats?model=all", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/models", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/train/jobs", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ]);
    setCorpus(c.status === "fulfilled" ? (c.value as CorpusStats) : "unavailable");
    setArena(a.status === "fulfilled" ? (a.value as ArenaStats) : null);
    setModels(m.status === "fulfilled" ? (m.value as ModelEntry[]) : []);
    setJobs(j.status === "fulfilled" ? (j.value as TrainingJob[]) : []);
    // Decided pairs per model: the export is the source of truth for DPO counts.
    try {
      const pairs = (await fetch("/api/arena/export?format=json", { cache: "no-store" }).then((r) => r.json())) as {
        model: string;
        trial?: string;
        chosen: { instruct: string };
        rejected: { instruct: string };
      }[];
      // DPO needs two samples of the same prompt: only pairs whose sides share the instruction count.
      const counts: Record<string, number> = {};
      for (const p of pairs) {
        const t = p.trial ?? "test";
        if ((t === "seed" || t === "test") && p.chosen.instruct.trim() === p.rejected.instruct.trim()) counts[p.model] = (counts[p.model] ?? 0) + 1;
      }
      setPairCounts(counts);
    } catch {
      setPairCounts({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const anyRunning = jobs.some((j) => RUNNING.has(j.status));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => {
      fetch("/api/train/jobs", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: TrainingJob[]) => {
          setJobs(j);
          if (!j.some((x) => RUNNING.has(x.status))) load();
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  useEffect(() => {
    if (!sftBase && models.length) setSftBase(models.find((m) => m.kind === "base")?.id ?? models[0].id);
    if (!dpoBase && models.length) {
      const ft = models.find((m) => m.kind === "finetuned" && m.stage === "sft");
      setDpoBase(ft?.id ?? models.find((m) => m.active)?.id ?? models[0].id);
    }
  }, [models, sftBase, dpoBase]);

  const stats = corpus !== "unavailable" ? corpus : null;
  const neutralSec = stats?.acceptedSecondsByEmotion?.neutral ?? 0;
  const sftThreshold = stats?.thresholds.sftSec ?? 600;
  const usableSec = stats === null ? 0 : includeBorderline ? stats.acceptedSeconds : stats.cleanSeconds ?? stats.acceptedSeconds;
  const sftReady = stats !== null && usableSec >= sftThreshold;
  const sftReason =
    corpus === "unavailable"
      ? "corpus stats unavailable (record page not built yet?)"
      : stats === null
      ? "loading…"
      : !sftReady
      ? `need ${fmtSec(sftThreshold)} of ${includeBorderline ? "accepted" : "clean"} speech, have ${fmtSec(usableSec)}`
      : anyRunning
      ? "a job is running"
      : "";

  const dpoModelKey = models.find((m) => m.id === dpoBase);
  const dpoPairs = (dpoBase && (pairCounts[dpoBase] ?? pairCounts[dpoModelKey?.name ?? ""] ?? 0)) || 0;
  const dpoReady = dpoPairs >= DPO_MIN_PAIRS || dpoForce;

  async function post(url: string, body: unknown, label: string) {
    setBusy(label);
    setError("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${label} failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Fine-tune</h2>
        <p className="text-sm text-gray-500 mt-1">
          Stage A adapts the CosyVoice LLM to your corpus; stage B optimizes it on your arena preferences. Protocol §3.
        </p>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {/* Readiness */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Readiness</h3>
        {corpus === "unavailable" ? (
          <p className="text-sm text-amber-700">corpus stats unavailable</p>
        ) : stats === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <Stat label="Accepted speech" value={fmtSec(stats.acceptedSeconds)} sub={`${stats.accepted} of ${stats.takes} takes · ${fmtSec(stats.cleanSeconds ?? stats.acceptedSeconds)} clean, ${fmtSec(stats.borderlineSeconds ?? 0)} borderline`} />
            <Stat label="Neutral speech" value={fmtSec(neutralSec)} sub={`SFT needs ${fmtSec(sftThreshold)}, ${fmtSec(stats.thresholds.sftRecommendedSec)} recommended`} />
            <Stat label="Sentences / words" value={`${stats.sentences} / ${stats.distinctWords}`} sub="CMU ARCTIC order keeps it balanced" />
            <Stat
              label="Decided pairs"
              value={String(Object.values(pairCounts).reduce((a, b) => a + b, 0))}
              sub={arena ? `${arena.totalRounds} rounds · ${arena.totalVotes} votes · DPO needs ${DPO_MIN_PAIRS} per base model` : "arena stats unavailable"}
            />
          </div>
        )}
        {stats && Object.keys(stats.acceptedSecondsByEmotion).length > 1 && (
          <p className="text-xs text-gray-500 mt-3">
            Per emotion:{" "}
            {Object.entries(stats.acceptedSecondsByEmotion)
              .map(([k, v]) => `${k} ${fmtSec(v)}`)
              .join(" · ")}
          </p>
        )}
      </section>

      {/* Stage A */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Stage A · speaker adaptation (SFT)</h3>
          <p className="text-xs text-gray-500 mt-1">
            Accepted takes → CAM++ embeddings → speech tokens → parquet → train the LLM from the base checkpoint → average best epochs → models/&lt;name&gt;.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Field label="Name">
            <input value={sftName} onChange={(e) => setSftName(e.target.value)} className="input" />
          </Field>
          <Field label="Base model">
            <select value={sftBase} onChange={(e) => setSftBase(e.target.value)} className="input">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Epochs">
            <input type="number" min={1} max={500} value={epochs} onChange={(e) => setEpochs(Math.max(1, parseInt(e.target.value || "1", 10)))} className="input" />
          </Field>
          <Field label="Learning rate">
            <input value={lr} onChange={(e) => setLr(e.target.value)} className="input" />
          </Field>
          <Field label="Held-out fraction">
            <input type="number" min={0} max={0.5} step={0.01} value={heldout} onChange={(e) => setHeldout(parseFloat(e.target.value || "0.05"))} className="input" />
          </Field>
          <Field label="Seed">
            <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || "1234", 10))} className="input" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={includeBorderline} onChange={(e) => setIncludeBorderline(e.target.checked)} className="accent-indigo-600" />
          Include borderline takes (reverb tail −25…−20 dB; unaltered recordings, recorded on the model card)
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={trainFlow} onChange={(e) => setTrainFlow(e.target.checked)} className="accent-indigo-600" />
          Also fine-tune the flow model (needs ≥ 30 min; not wired yet, the backend will refuse)
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!sftReady || anyRunning || !!busy || !sftName.trim()}
            onClick={() =>
              post(
                "/api/train/sft",
                { name: sftName.trim(), speakerId: stats?.speakerId ?? "owner", baseModel: sftBase, epochs, lr: parseFloat(lr), heldoutFraction: heldout, seed, trainFlow, includeBorderline },
                "Start SFT"
              )
            }
            className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === "Start SFT" ? "Starting…" : "Start stage A"}
          </button>
          {sftReason && <span className="text-xs text-gray-500">{sftReason}</span>}
        </div>
        <p className="text-xs text-gray-400">
          Training needs about 10 GiB of free VRAM. The backend refuses to start below 8 GiB: unload the studio TTS model and stop the digital-human backend first.
        </p>
      </section>

      {/* Stage B */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Stage B · preference optimization (DPO)</h3>
          <p className="text-xs text-gray-500 mt-1">
            Decided arena pairs made with the chosen checkpoint where both sides share the instruction (seed trials): chosen tokens vs rejected tokens, reference model = that checkpoint.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Name">
            <input value={dpoName} onChange={(e) => setDpoName(e.target.value)} className="input" />
          </Field>
          <Field label="Base checkpoint">
            <select value={dpoBase} onChange={(e) => setDpoBase(e.target.value)} className="input">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.kind === "finetuned" ? ` (${m.stage})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Epochs">
            <input type="number" min={1} max={100} value={dpoEpochs} onChange={(e) => setDpoEpochs(Math.max(1, parseInt(e.target.value || "1", 10)))} className="input" />
          </Field>
          <Field label="Pairs for this checkpoint">
            <div className={`text-sm font-semibold ${dpoPairs >= DPO_MIN_PAIRS ? "text-green-700" : "text-amber-700"}`}>
              {dpoPairs} / {DPO_MIN_PAIRS}
            </div>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={dpoForce} onChange={(e) => setDpoForce(e.target.checked)} className="accent-indigo-600" />
          Force below {DPO_MIN_PAIRS} pairs (smoke tests only; the result will overfit)
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!dpoReady || anyRunning || !!busy || !dpoName.trim() || !dpoBase}
            onClick={() => post("/api/train/dpo", { name: dpoName.trim(), baseModel: dpoBase, epochs: dpoEpochs, force: dpoForce }, "Start DPO")}
            className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === "Start DPO" ? "Starting…" : "Start stage B"}
          </button>
          {!dpoReady && <span className="text-xs text-gray-500">refused below {DPO_MIN_PAIRS} pairs unless forced</span>}
        </div>
      </section>

      {/* Jobs */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900">Jobs ({jobs.length})</h3>
        {jobs.length === 0 && <p className="text-sm text-gray-400">No training jobs yet.</p>}
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} onCancel={() => post(`/api/train/jobs/${j.id}/cancel`, {}, "Cancel")} />
        ))}
      </section>

      {/* Models */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Models</h3>
          <p className="text-xs text-gray-500 mt-1">
            Switching changes the <code>model</code> recorded on every new arena round, so a checkpoint is evaluated against the base with the same blind protocol.
          </p>
        </div>
        {models.length === 0 && <p className="text-sm text-gray-400">Backend unreachable or no models listed.</p>}
        <ul className="divide-y divide-gray-100">
          {models.map((m) => (
            <li key={m.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${m.active ? "bg-indigo-50/60 -mx-2 px-2 rounded-lg" : ""}`}>
              <div className="min-w-0">
                <div className="text-sm text-gray-900 flex items-center gap-2">
                  <span className="font-medium truncate">{m.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{m.kind}{m.stage ? ` · ${m.stage}` : ""}</span>
                  {m.active && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-600 text-white">active</span>}
                </div>
                <div className="text-xs text-gray-400 truncate">{m.id}{m.baseModel ? ` · from ${m.baseModel.split("/").pop()}` : ""}</div>
              </div>
              <button
                type="button"
                disabled={m.active || anyRunning || !!busy}
                onClick={() => post("/api/models/select", { id: m.id }, "Select model")}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {m.active ? "In use" : "Use in backend"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <style jsx global>{`
        .input {
          width: 100%;
          padding: 0.375rem 0.625rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          background: white;
        }
      `}</style>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function JobCard({ job, onCancel }: { job: TrainingJob; onCancel: () => void }) {
  const [open, setOpen] = useState(RUNNING.has(job.status));
  const running = RUNNING.has(job.status);
  return (
    <div className="border border-gray-200 rounded-xl bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-left">
        <span className="text-sm text-gray-800">
          <span className="font-medium">{job.name}</span>
          <span className="ml-2 text-xs text-gray-400">{job.stage.toUpperCase()} · {new Date(job.createdAt).toLocaleString()}</span>
        </span>
        <span className="flex items-center gap-2 text-xs">
          {job.step !== undefined && <span className="text-gray-500">step {job.step}{job.totalSteps ? ` / ${job.totalSteps}` : ""}</span>}
          {job.trainLoss !== undefined && <span className="text-gray-500">train {job.trainLoss.toFixed(4)}</span>}
          {job.cvLoss !== undefined && <span className="text-gray-500">cv {job.cvLoss.toFixed(4)}</span>}
          <span className={`px-2 py-0.5 rounded-full border ${statusClass(job.status)}`}>{job.status}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-2">
          {job.error && <p className="text-sm text-red-700">{job.error}</p>}
          {job.outputDir && <p className="text-xs text-gray-500">output: {job.outputDir}</p>}
          <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 max-h-72 overflow-auto whitespace-pre-wrap">
            {job.logTail.length ? job.logTail.join("\n") : "(no log yet)"}
          </pre>
          {running && (
            <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
              Cancel job
            </button>
          )}
        </div>
      )}
    </div>
  );
}
