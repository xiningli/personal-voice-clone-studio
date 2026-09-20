"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CorpusStats, Language, Take, VoiceProfileSummary } from "@/lib/types";
import type { BankStatus } from "@/lib/corpus";
import { EMOTIONS, LANGUAGE_OPTIONS, emotionHint, emotionLabel } from "@/lib/reading-scripts";
import AudioPlayer from "./AudioPlayer";

// Re-exported so older imports keep working.
export { EMOTIONS, emotionLabel } from "@/lib/reading-scripts";

const SPEAKER = "owner";
const PROFILE_TARGET_SEC = 300; // 5 min per emotion (protocol §1); neutral targets the 10 min SFT minimum
function targetFor(emotion: string): number {
  return emotion === "neutral" ? 600 : PROFILE_TARGET_SEC;
}

interface Prompt {
  id: string;
  text: string;
}

function recordingBlockedReason(): string | null {
  if (typeof window === "undefined") return null;
  if (window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function") return null;
  return `Recording needs HTTPS or localhost. You are on ${window.location.origin}, where the browser exposes no microphone. Open https://${window.location.host} (accept the self-signed certificate once), or upload a clip recorded elsewhere.`;
}

/** Turn a QC reason string into advice a person can act on. */
function explainReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.startsWith("snr") && r.includes("borderline")) return `Mild background noise (${reason}). Accepted, counted, excluded from training unless you opt in. Closer to the mic or more input gain fixes it.`;
  if (r.startsWith("quiet signal")) return `Recording level is low (${reason}). Raise the microphone input gain in the OS sound settings, or hold the mic closer; louder speech against the same noise raises the SNR.`;
  if (r.startsWith("reverb") && r.includes("borderline")) return `Mild room sound (${reason}). Accepted and counted, but left out of training unless you opt in. Closer to the mic or softer surroundings would make it clean.`;
  if (r.startsWith("reverb")) return `Room echo (${reason}). Move closer to the mic, or to a smaller room with soft surfaces.`;
  if (r.startsWith("noise floor")) return `Background noise (${reason}). Turn off fans/AC, close the window, or move the mic closer.`;
  if (r.startsWith("snr")) return `Voice too quiet against the background (${reason}). Speak closer to the mic or raise input gain.`;
  if (r.startsWith("peak") || r.startsWith("clipping")) return `Too loud, the signal clipped (${reason}). Lower input gain or back off the mic.`;
  if (r.startsWith("wer")) return `Words did not match the prompt (${reason}). Read the sentence exactly as written, at a natural pace.`;
  if (r.startsWith("duration")) return `Length out of range (${reason}). Start speaking right after pressing record and stop right after the last word.`;
  return reason;
}

function fmtMin(sec: number): string {
  return `${(sec / 60).toFixed(1)} min`;
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Bar({ value, max, label, small }: { value: number; max: number; label?: string; small?: boolean }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div>
      {label && (
        <div className="flex justify-between text-xs text-gray-600 mb-0.5">
          <span>{label}</span>
          <span className="tabular-nums">
            {fmtMin(value)} / {fmtMin(max)}
          </span>
        </div>
      )}
      <div className={`${small ? "h-1.5" : "h-2"} rounded-full bg-gray-100 overflow-hidden`}>
        <div className={`h-full ${pct >= 100 ? "bg-green-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TakeMetricsLine({ t }: { t: Take }) {
  return (
    <span className="text-xs text-gray-500 tabular-nums">
      {t.metrics.duration.toFixed(1)} s · peak {t.metrics.peakDbfs.toFixed(1)} dBFS · noise {t.metrics.noiseFloorDb.toFixed(0)} dB · SNR{" "}
      {t.metrics.snrDb.toFixed(0)} dB · echo {t.metrics.reverbTailDb === null ? "–" : `${t.metrics.reverbTailDb.toFixed(0)} dB`} · WER{" "}
      {t.metrics.wer.toFixed(2)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Session: one sentence at a time, recorded for one profile, judged on the spot.
// ---------------------------------------------------------------------------------------

function ProfileSession({
  profile,
  onChanged,
  onClose,
}: {
  profile: VoiceProfileSummary;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [current, setCurrent] = useState<Prompt | null>(null);
  const [bank, setBank] = useState<BankStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Take | null>(null);
  const [error, setError] = useState("");
  const [acceptedCount, setAcceptedCount] = useState(profile.acceptedTakes);
  const [acceptedSec, setAcceptedSec] = useState(profile.acceptedSeconds);
  const sessionIdRef = useRef(`s-${Date.now().toString(36)}`);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadBank = useCallback(async () => {
    try {
      const r = await fetch(`/api/corpus/bank?profileId=${profile.id}`, { cache: "no-store" });
      if (r.ok) setBank((await r.json()) as BankStatus);
    } catch {
      /* status is advisory */
    }
  }, [profile.id]);

  const loadQueue = useCallback(async () => {
    try {
      const r = await fetch(`/api/corpus/prompts?profileId=${profile.id}&n=10`, { cache: "no-store" });
      const list = (await r.json()) as Prompt[];
      setQueue(Array.isArray(list) ? list : []);
      setCurrent(Array.isArray(list) && list.length ? list[0] : null);
    } catch {
      setQueue([]);
      setCurrent(null);
    }
    loadBank();
  }, [profile.id, loadBank]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const upload = useCallback(
    async (file: File, prompt: Prompt) => {
      setUploading(true);
      setError("");
      try {
        const fd = new FormData();
        fd.append("audio", file);
        fd.append("promptId", prompt.id);
        fd.append("text", prompt.text);
        fd.append("profileId", profile.id);
        fd.append("sessionId", sessionIdRef.current);
        fd.append("speaker", SPEAKER);
        const res = await fetch("/api/corpus/takes", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        const take = data as Take;
        setResult(take);
        if (take.verdict === "accept") {
          setAcceptedCount((n) => n + 1);
          setAcceptedSec((s) => s + take.metrics.duration);
        }
        loadBank();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [profile.id, onChanged, loadBank]
  );

  const startRecording = useCallback(async () => {
    if (!current || recording || uploading) return;
    setError("");
    setResult(null);
    const blocked = recordingBlockedReason();
    if (blocked) {
      setError(blocked);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      setError(`Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const rec = new MediaRecorder(stream);
    recorderRef.current = rec;
    chunksRef.current = [];
    const prompt = current;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      upload(new File([blob], "take.webm", { type: "audio/webm" }), prompt);
    };
    rec.start();
    setRecording(true);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
  }, [current, recording, uploading, upload]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const next = useCallback(() => {
    if (recording || uploading) return;
    setResult(null);
    if (result?.verdict === "accept") {
      const rest = queue.filter((p) => p.id !== result.promptId);
      if (rest.length === 0) {
        loadQueue();
        return;
      }
      setQueue(rest);
      setCurrent(rest[0]);
    } else {
      const idx = queue.findIndex((p) => p.id === current?.id);
      setCurrent(queue[(idx + 1) % Math.max(1, queue.length)] ?? null);
    }
  }, [recording, uploading, result, queue, current, loadQueue]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (recording) stopRecording();
        else startRecording();
      } else if (e.code === "Enter") {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, startRecording, stopRecording, next]);

  const isScript = current ? !current.id.startsWith("arctic_") : false;

  return (
    <div className="bg-white border border-indigo-300 ring-1 ring-indigo-100 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            Recording for <span className="text-indigo-700">{profile.name}</span>
            <span className="ml-2 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-xs font-normal">
              {emotionLabel(profile.emotion)}
            </span>
          </h3>
          <p className="text-xs text-gray-500 mt-1">How to read: {emotionHint(profile.emotion)}</p>
          <p className="text-xs text-gray-500">
            Every take is checked for level, noise, room echo and intelligibility before it counts. Space = record/stop, Enter = next.
            {profile.language === "zh" && " Chinese profiles use the Chinese scripts only (the ARCTIC sentence set is English)."}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">
          Close session
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-600">
          <span className="tabular-nums">
            accepted {acceptedCount} · {fmtClock(acceptedSec)} for this profile · target {fmtClock(targetFor(profile.emotion))}
          </span>
          <span>{queue.length} left in this batch</span>
        </div>
        <Bar value={acceptedSec} max={targetFor(profile.emotion)} small />
        {bank && (
          <p className="text-xs text-gray-500 tabular-nums">
            Bank <span className="font-medium text-gray-700">{bank.bank}</span>: {bank.remaining} of {bank.total} sentences left
            (≈ {fmtClock(bank.remainingEstSeconds)} of speech) · this emotion has {fmtClock(bank.acceptedSeconds)} of {fmtClock(bank.targetSeconds)} ·
            about <span className="font-medium text-gray-700">{bank.sentencesNeeded}</span> more accepted sentences needed, ≈ {bank.takesNeeded} recordings at your{" "}
            {Math.round(bank.acceptRate * 100)}% pass rate{bank.enough ? "" : " — the bank is smaller than that, tell me to extend it"}
          </p>
        )}
      </div>

      {current ? (
        <>
          <div className="text-xs text-gray-400">
            {current.id}
            {isScript && <span className="ml-2 text-indigo-500">reading script for this emotion</span>}
          </div>
          <p className="text-2xl md:text-3xl leading-snug text-gray-900 font-medium">{current.text}</p>
        </>
      ) : (
        <p className="text-sm text-gray-500">No prompts left for this profile.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={!current || uploading}
          className={`px-8 py-4 rounded-xl text-base font-semibold transition-colors disabled:opacity-50 ${
            recording ? "bg-red-600 text-white hover:bg-red-700 animate-pulse" : "bg-indigo-600 text-white hover:bg-indigo-700"
          }`}
        >
          {recording ? `■ Stop (${elapsed}s)` : uploading ? "Checking…" : "● Record"}
        </button>
        <button
          type="button"
          onClick={next}
          disabled={!current || recording || uploading}
          className="px-5 py-3 rounded-xl text-sm border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          {result?.verdict === "accept" ? "Next →" : "Skip →"}
        </button>
        {result && !recording && !uploading && (
          <button type="button" onClick={startRecording} className="px-5 py-3 rounded-xl text-sm border border-gray-300 hover:bg-gray-50">
            Re-record
          </button>
        )}
      </div>

      {error && <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">{error}</div>}

      {result && (
        <div
          className={`rounded-xl border p-4 space-y-3 ${
            result.verdict !== "accept"
              ? "bg-amber-50 border-amber-200"
              : result.quality === "borderline"
              ? "bg-lime-50 border-lime-200"
              : "bg-green-50 border-green-200"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-sm font-semibold ${result.verdict === "accept" ? (result.quality === "borderline" ? "text-lime-800" : "text-green-800") : "text-amber-800"}`}>
              {result.verdict !== "accept"
                ? "Rejected — not added"
                : result.quality === "borderline"
                ? "Accepted as borderline — added, excluded from training by default"
                : "Accepted — added to this profile"}
            </span>
            <TakeMetricsLine t={result} />
          </div>
          {(result.reasons.length > 0 || (result.warnings?.length ?? 0) > 0) && (
            <ul className="text-sm text-amber-900 list-disc list-inside space-y-1">
              {[...result.reasons, ...(result.warnings ?? [])].map((r) => (
                <li key={r}>{explainReason(r)}</li>
              ))}
            </ul>
          )}
          {result.metrics.transcript && (
            <p className="text-xs text-gray-600">
              <span className="text-gray-400 mr-1">heard:</span>
              {result.metrics.transcript}
            </p>
          )}
          <audio controls preload="metadata" src={`/api/corpus/takes/${result.id}?speaker=${SPEAKER}`} className="w-full" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Profile card
// ---------------------------------------------------------------------------------------

function ProfileCard({
  profile,
  active,
  onOpenSession,
  onDelete,
  onChanged,
}: {
  profile: VoiceProfileSummary;
  active: boolean;
  onOpenSession: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [showTakes, setShowTakes] = useState(false);
  const [takes, setTakes] = useState<Take[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<Take | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [error, setError] = useState("");

  const loadTakes = useCallback(async () => {
    try {
      const r = await fetch(`/api/corpus/takes?profileId=${profile.id}&speaker=${SPEAKER}`, { cache: "no-store" });
      const list = (await r.json()) as Take[];
      setTakes(Array.isArray(list) ? list : []);
    } catch {
      setTakes([]);
    }
  }, [profile.id]);

  useEffect(() => {
    if (showTakes) loadTakes();
  }, [showTakes, loadTakes, profile.acceptedTakes, profile.rejectedTakes]);

  async function deleteTake(id: string) {
    await fetch(`/api/corpus/takes/${id}?speaker=${SPEAKER}`, { method: "DELETE" });
    await loadTakes();
    onChanged();
  }

  async function uploadClip() {
    if (!uploadFile || !uploadTranscript.trim()) return;
    setUploading(true);
    setError("");
    setUploadResult(null);
    try {
      const fd = new FormData();
      fd.append("audio", uploadFile);
      fd.append("promptId", `upload-${Date.now().toString(36)}`);
      fd.append("text", uploadTranscript.trim());
      fd.append("profileId", profile.id);
      fd.append("sessionId", "upload");
      fd.append("speaker", SPEAKER);
      const res = await fetch("/api/corpus/takes", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      setUploadResult(data as Take);
      setUploadFile(null);
      onChanged();
      if (showTakes) loadTakes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const ready = !!profile.promptAudioPath;

  return (
    <div className={`bg-white border rounded-xl p-5 space-y-4 ${active ? "border-indigo-300" : "border-gray-200"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900">{profile.name}</h3>
            <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-xs">{emotionLabel(profile.emotion)}</span>
            <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">{profile.language}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs ${ready ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-800"}`}>
              {ready ? `${profile.acceptedTakes} accepted` : "no accepted take yet"}
            </span>
            {profile.rejectedTakes > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">{profile.rejectedTakes} rejected</span>
            )}
          </div>
          {profile.description && <p className="text-sm text-gray-500 mt-0.5">{profile.description}</p>}
          <p className="text-xs text-gray-400 mt-1">Created {new Date(profile.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenSession}
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700"
          >
            {active ? "Session open" : ready ? "Add takes" : "Start recording"}
          </button>
          <button type="button" onClick={onDelete} className="text-gray-400 hover:text-red-500 transition-colors" title="Delete profile and its takes">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      <Bar
        value={profile.acceptedSeconds}
        max={targetFor(profile.emotion)}
        label={profile.emotion === "neutral" ? "Accepted speech → speaker-adaptation SFT (10 min)" : "Accepted speech → emotion-conditioned SFT (5 min)"}
      />

      {ready ? (
        <div className="space-y-2">
          <AudioPlayer
            src={`${profile.promptAudioPath}?v=${encodeURIComponent(profile.updatedAt)}`}
            label={`Cloning prompt (derived from the best accepted take(s), ${profile.durationSeconds?.toFixed(1) ?? "?"} s)`}
            compact
          />
          <p className="text-xs text-gray-600">
            <span className="text-gray-400 mr-1">transcript:</span>
            {profile.promptText}
          </p>
        </div>
      ) : (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
          This profile cannot be used for generation or training until at least one take passes quality control.
        </p>
      )}

      <div className="flex flex-wrap gap-4 text-xs">
        <button type="button" onClick={() => setShowTakes((s) => !s)} className="text-gray-600 hover:text-gray-900">
          {showTakes ? "▾ Hide takes" : `▸ Takes (${profile.acceptedTakes + profile.rejectedTakes})`}
        </button>
        <button type="button" onClick={() => setShowUpload((s) => !s)} className="text-gray-600 hover:text-gray-900">
          {showUpload ? "▾ Hide upload" : "▸ Upload a clip (goes through the same QC)"}
        </button>
      </div>

      {showUpload && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <textarea
            value={uploadTranscript}
            onChange={(e) => setUploadTranscript(e.target.value)}
            rows={2}
            placeholder="Exact words spoken in the clip (QC compares them with what whisper hears)"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="px-3 py-1.5 bg-gray-100 border border-gray-300 rounded-lg text-xs cursor-pointer hover:bg-gray-200">
              Choose file
              <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </label>
            {uploadFile && <span className="text-xs text-gray-600">{uploadFile.name}</span>}
            <button
              type="button"
              onClick={uploadClip}
              disabled={!uploadFile || !uploadTranscript.trim() || uploading}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {uploading ? "Checking…" : "Upload and check"}
            </button>
          </div>
          {uploadResult && (
            <div className={`rounded-lg border p-3 text-sm ${uploadResult.verdict === "accept" ? "bg-green-50 border-green-200 text-green-800" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
              <div className="font-medium">{uploadResult.verdict === "accept" ? "Accepted" : "Rejected"}</div>
              {uploadResult.reasons.map((r) => (
                <div key={r}>{explainReason(r)}</div>
              ))}
            </div>
          )}
          {error && <div className="text-sm text-red-700">{error}</div>}
        </div>
      )}

      {showTakes && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
          {takes === null && <p className="px-4 py-3 text-sm text-gray-400">Loading…</p>}
          {takes && takes.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">No takes yet.</p>}
          {takes?.map((t) => (
            <div key={t.id} className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm">
              <span className={`px-2 py-0.5 rounded-full text-xs ${t.verdict !== "accept" ? "bg-amber-50 text-amber-700" : t.quality === "borderline" ? "bg-lime-50 text-lime-700" : "bg-green-50 text-green-700"}`}>
                {t.verdict === "accept" && t.quality === "borderline" ? "borderline" : t.verdict}
              </span>
              <span className="text-gray-800 flex-1 min-w-48 truncate" title={t.text}>
                {t.text}
              </span>
              <TakeMetricsLine t={t} />
              <audio controls preload="none" src={`/api/corpus/takes/${t.id}?speaker=${SPEAKER}`} className="h-8 w-44" />
              <button type="button" onClick={() => deleteTake(t.id)} className="text-xs text-gray-400 hover:text-red-600">
                delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------

export default function VoiceProfileManager() {
  const [profiles, setProfiles] = useState<VoiceProfileSummary[]>([]);
  const [stats, setStats] = useState<CorpusStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [emotion, setEmotion] = useState("neutral");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<{ card: string; count: number; seconds: number; exportDir: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [requalifying, setRequalifying] = useState(false);
  const [requalifyNote, setRequalifyNote] = useState("");
  async function requalify() {
    setRequalifying(true);
    setRequalifyNote("");
    try {
      const res = await fetch("/api/corpus/requalify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speaker: SPEAKER }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-check failed");
      setRequalifyNote(`${data.requalified} takes re-checked · ${data.changed} changed verdict · now ${data.accepted} accepted (${data.borderline} borderline), ${data.rejected} rejected`);
      await refresh();
    } catch (err) {
      setRequalifyNote(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setRequalifying(false);
    }
  }
  const [pageError, setPageError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        fetch("/api/tts/profiles", { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/corpus/stats?speaker=${SPEAKER}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      setProfiles(Array.isArray(p) ? p : []);
      setStats(s && !s.error ? s : null);
    } catch {
      setProfiles([]);
      setStats(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createProfile(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setFormError("");
    try {
      const res = await fetch("/api/tts/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || `${emotionLabel(emotion).split(" / ")[0]} · ${language}`, language, emotion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setShowForm(false);
      setName("");
      await refresh();
      setSessionId(data.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create profile");
    } finally {
      setCreating(false);
    }
  }

  async function deleteProfile(id: string) {
    const p = profiles.find((x) => x.id === id);
    const n = p ? p.acceptedTakes + p.rejectedTakes : 0;
    const label = p ? `${emotionLabel(p.emotion).split(" / ")[1]} (${p.language})` : "this category";
    if (!window.confirm(`Delete the ${label} profile and all ${n} takes of that category? Recordings are removed from disk. This cannot be undone.`)) return;
    if (sessionId === id) setSessionId(null);
    await fetch(`/api/tts/profiles/${id}`, { method: "DELETE" });
    refresh();
  }

  async function handleExport() {
    setExporting(true);
    setPageError("");
    try {
      const r = await fetch(`/api/corpus/export?speaker=${SPEAKER}`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Export failed");
      setExportInfo(data);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const th = stats?.thresholds;
  const sessionProfile = profiles.find((p) => p.id === sessionId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Voice Profiles</h2>
          <p className="text-sm text-gray-500 mt-1">
            One profile per emotion. Each is recorded sentence by sentence, every take is judged by the same quality control the
            training data requires, and the cloning prompt is built from the accepted takes.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || !stats || stats.accepted === 0}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export dataset"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowForm((s) => !s);
              setFormError("");
            }}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            {showForm ? "Cancel" : "+ New profile"}
          </button>
        </div>
      </div>

      {/* Corpus readiness */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">
            Corpus readiness
            <button
              type="button"
              onClick={requalify}
              disabled={requalifying || !stats || stats.takes === 0}
              title="Re-run quality control on every stored take with the current rules (no re-recording)"
              className="ml-3 px-2 py-0.5 text-xs font-normal border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {requalifying ? "Re-checking…" : "Re-run QC on all takes"}
            </button>
            {requalifyNote && <span className="ml-2 text-xs font-normal text-gray-500">{requalifyNote}</span>}
          </h3>
          {stats && (
            <span className="text-xs text-gray-500">
              {stats.accepted} accepted ({stats.borderlineTakes ?? 0} borderline) · {stats.rejected} rejected · {stats.sentences} sentences · {stats.distinctWords} words
            </span>
          )}
        </div>
        {stats && th ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Bar value={stats.cleanSecondsByEmotion?.["neutral"] ?? stats.acceptedSecondsByEmotion["neutral"] ?? 0} max={th.sftSec} label={`Neutral, clean → speaker-adaptation SFT (10 min)${(stats.acceptedSecondsByEmotion["neutral"] ?? 0) - (stats.cleanSecondsByEmotion?.["neutral"] ?? 0) > 0 ? ` · +${fmtMin((stats.acceptedSecondsByEmotion["neutral"] ?? 0) - (stats.cleanSecondsByEmotion?.["neutral"] ?? 0))} borderline` : ""}`} />
            <Bar value={stats.cleanSecondsByEmotion?.["neutral"] ?? stats.acceptedSecondsByEmotion["neutral"] ?? 0} max={th.sftRecommendedSec} label="Neutral, clean → recommended (30 min)" />
            <Bar value={stats.acceptedSeconds} max={th.zeroShotProfileSec} label="Any emotion → better zero-shot cloning (1 min)" />
            <div>
              <p className="text-xs text-gray-600 mb-1">Per emotion → emotion-conditioned SFT (5 min each)</p>
              <div className="flex flex-wrap gap-1.5">
                {EMOTIONS.map((e) => {
                  const sec = stats.acceptedSecondsByEmotion[e.id] ?? 0;
                  return (
                    <span
                      key={e.id}
                      className={`px-2 py-0.5 rounded-full text-xs border ${
                        sec >= th.emotionSftSec
                          ? "bg-green-50 text-green-700 border-green-200"
                          : sec > 0
                          ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                          : "bg-white text-gray-400 border-gray-200"
                      }`}
                    >
                      {e.label.split(" / ")[1]} {sec > 0 ? fmtMin(sec) : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400">{loading ? "Loading…" : "Corpus stats unavailable (is the backend running?)"}</p>
        )}
      </div>

      {showForm && (
        <form onSubmit={createProfile} className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${emotionLabel(emotion).split(" / ")[0]} · ${language}`}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {language === "zh" && (
                <p className="text-xs text-gray-400 mt-1">Chinese profiles record the Chinese scripts only; the ARCTIC sentence set is English.</p>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Emotion <span className="text-gray-400 font-normal">— every take of this profile is read in this mood</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {EMOTIONS.map((e) => {
                const has = profiles.some((p) => p.emotion === e.id && p.language === language);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setEmotion(e.id)}
                    title={has ? "A profile for this category exists; Create opens it" : undefined}
                    className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                      emotion === e.id ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-700 border-gray-300 hover:border-indigo-400"
                    }`}
                  >
                    {e.label}
                    {has ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mt-2">How to read: {emotionHint(emotion)}</p>
            {profiles.some((p) => p.emotion === emotion && p.language === language) && (
              <p className="text-xs text-indigo-700 mt-1">
                One profile per category: this {language} {emotionLabel(emotion).split(" / ")[1]} profile already exists, so the button below opens it and adds takes to it.
              </p>
            )}
          </div>
          {formError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>}
          <button
            type="submit"
            disabled={creating}
            className="px-6 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {creating
              ? "Opening…"
              : profiles.some((p) => p.emotion === emotion && p.language === language)
              ? "Open existing profile and record"
              : "Create and start recording"}
          </button>
        </form>
      )}

      {sessionProfile && (
        <ProfileSession key={sessionProfile.id} profile={sessionProfile} onChanged={refresh} onClose={() => setSessionId(null)} />
      )}

      {pageError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{pageError}</div>}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading profiles...</div>
      ) : profiles.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <p className="text-gray-500 text-sm">No voice profiles yet. Create one and read the sentences it gives you.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              active={sessionId === profile.id}
              onOpenSession={() => setSessionId(profile.id)}
              onDelete={() => deleteProfile(profile.id)}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {exportInfo && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Dataset exported</h3>
            <span className="text-xs text-gray-500">
              {exportInfo.count} takes · {fmtMin(exportInfo.seconds)} · {exportInfo.exportDir}
            </span>
          </div>
          <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{exportInfo.card}</pre>
        </div>
      )}
    </div>
  );
}
