"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ArenaCandidate,
  ArenaRound,
  ArenaVariant,
  ArenaVote,
  CandidateRating,
  VoiceProfile,
  VoiceStylePreset,
  TrialType,
} from "@/lib/types";
import AudioPlayer from "./AudioPlayer";
import ArenaLeaderboard from "./ArenaLeaderboard";
import ModelSwitch, { shortModelName } from "./ModelSwitch";
import type { ModelEntry } from "@/lib/types";

const SAMPLE_LINES: { label: string; text: string }[] = [
  { label: "Lecture", text: "Hello everyone. Today we are going to talk about one of the most fundamental ideas in programming: variables." },
  { label: "Greeting", text: "Hi, welcome in. I'm glad you found your way here. Take a look around, and ask me anything that catches your eye." },
  { label: "Question", text: "So here's a question for you. What do you think happens if we double the learning rate?" },
  { label: "Thinking", text: "Hmm, that's a good one. Let me think about it for a second. I believe the short answer is yes, but it depends on the data." },
];
const DEFAULT_TEXT = SAMPLE_LINES[0].text;
const DEFAULT_VARIANTS = ["", "Speak warmly and enthusiastically, like greeting students at the start of class."];

interface VariantRow extends ArenaVariant {
  key: string;
}

interface HealthInfo {
  reachable: boolean;
  model?: string;
  ready?: boolean;
  loading?: boolean;
  [k: string]: unknown;
}

const RATING_DIMS: { key: keyof CandidateRating; label: string }[] = [
  { key: "naturalness", label: "Naturalness" },
  { key: "emotion", label: "Emotion match" },
  { key: "similarity", label: "Sounds like me" },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000);
}

function newRow(partial?: Partial<ArenaVariant>): VariantRow {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    instruct: partial?.instruct ?? "",
    speed: partial?.speed ?? 1.0,
    seed: partial?.seed,
    presetId: partial?.presetId,
  };
}

function RatingInput({ value, onChange }: { value: number | undefined; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`w-7 h-7 rounded text-xs font-medium border transition-colors ${
            value !== undefined && n <= value
              ? "bg-indigo-600 border-indigo-600 text-white"
              : "bg-white border-gray-300 text-gray-500 hover:border-indigo-400"
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function fmtMetric(v: number | null | undefined, digits = 2, suffix = ""): string {
  return v === null || v === undefined ? "–" : `${v.toFixed(digits)}${suffix}`;
}

function CandidateReveal({ c }: { c: ArenaCandidate }) {
  const m = c.metrics;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-gray-600">
      <dt className="text-gray-400">instruct</dt>
      <dd className={c.instruct ? "" : "italic text-gray-400"}>
        {c.isRecording ? (
          <span className="font-medium text-emerald-700">real recording (anchor)</span>
        ) : (
          c.instruct || "(neutral — no instruct)"
        )}
      </dd>
      {m && (
        <>
          <dt className="text-gray-400">metrics</dt>
          <dd className="tabular-nums">
            WER {fmtMetric(m.wer, 2)} · speaker sim {fmtMetric(m.speakerSimilarity, 3)} · reverb tail {fmtMetric(m.reverbTailDb, 1, " dB")}
          </dd>
        </>
      )}
      {c.model && (
        <>
          <dt className="text-gray-400">model</dt>
          <dd title={c.model}>
            {c.model.startsWith("/") || c.model.includes("/models/") ? "★ " : ""}
            {shortModelName(c.model)}
          </dd>
        </>
      )}
      <dt className="text-gray-400">speed</dt>
      <dd className="tabular-nums">{c.speed.toFixed(2)}×</dd>
      <dt className="text-gray-400">seed</dt>
      <dd className="tabular-nums">{c.seed}</dd>
      <dt className="text-gray-400">audio</dt>
      <dd className="tabular-nums">
        {c.duration.toFixed(2)} s in {c.elapsedSeconds.toFixed(2)} s
      </dd>
      {c.presetId && (
        <>
          <dt className="text-gray-400">preset</dt>
          <dd>{c.presetId}</dd>
        </>
      )}
    </dl>
  );
}

function TrialBadge({ trial }: { trial?: TrialType }) {
  const t = trial ?? "test";
  const cls =
    t === "repeat"
      ? "bg-amber-50 text-amber-700"
      : t === "anchor"
      ? "bg-emerald-50 text-emerald-700"
      : t === "duel"
      ? "bg-purple-50 text-purple-700"
      : "bg-gray-100 text-gray-600";
  const title =
    t === "repeat"
      ? "Repeat trial: a pair you already judged, re-served under fresh labels (test-retest reliability)"
      : t === "anchor"
      ? "Anchor trial: one candidate is a real recording of you"
      : t === "duel"
      ? "Duel trial: same line, instruction and seed; only the checkpoint differs"
      : "Test trial";
  return (
    <span title={title} className={`ml-2 px-2 py-0.5 rounded-full text-xs font-normal ${cls}`}>
      {t}
    </span>
  );
}

/** Blind listening + voting for one round; reveals after the vote is stored. */
function RoundVoting({
  round,
  existingVote,
  onVoted,
  onRerunWinner,
  onNewRoundSameText,
}: {
  round: ArenaRound;
  existingVote: ArenaVote | null;
  onVoted: (vote: ArenaVote) => void;
  onRerunWinner: (winner: ArenaCandidate) => void;
  onNewRoundSameText: () => void;
}) {
  const [winnerId, setWinnerId] = useState<string | null | undefined>(undefined);
  const [ratings, setRatings] = useState<Record<string, Partial<CandidateRating>>>({});
  const notes = ""; // round-level notes retired from the UI; remarks live on each track
  const [candidateNotes, setCandidateNotes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const revealed = existingVote !== null;

  function setRating(candidateId: string, key: keyof CandidateRating, value: number) {
    setRatings((prev) => ({ ...prev, [candidateId]: { ...prev[candidateId], [key]: value } }));
  }

  const ratingsComplete = round.candidates.every((c) => {
    const r = ratings[c.id];
    return r && r.naturalness && r.emotion && r.similarity;
  });

  async function submit() {
    if (winnerId === undefined) return;
    setSubmitting(true);
    setError("");
    try {
      const complete: Record<string, CandidateRating> = {};
      for (const c of round.candidates) {
        const r = ratings[c.id];
        if (r && r.naturalness && r.emotion && r.similarity) {
          complete[c.id] = { naturalness: r.naturalness, emotion: r.emotion, similarity: r.similarity };
        }
      }
      const res = await fetch("/api/arena/votes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundId: round.id, winnerId, ratings: complete, notes, candidateNotes }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Vote failed");
      }
      onVoted((await res.json()) as ArenaVote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote failed");
    } finally {
      setSubmitting(false);
    }
  }

  const winner = existingVote?.winnerId ? round.candidates.find((c) => c.id === existingVote.winnerId) : undefined;

  return (
    <div className="space-y-4">
      <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
        <span className="text-xs text-gray-400 mr-2">text</span>
        {round.text}
      </div>

      <div className="grid gap-3">
        {round.candidates.map((c) => {
          const isWinner = revealed ? existingVote?.winnerId === c.id : winnerId === c.id;
          const r = revealed ? existingVote?.ratings[c.id] : ratings[c.id];
          return (
            <div
              key={c.id}
              className={`border rounded-xl p-4 bg-white ${isWinner ? "border-indigo-400 ring-1 ring-indigo-200" : "border-gray-200"}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gray-900 text-white font-bold text-sm">
                  {c.label}
                </span>
                {revealed ? (
                  isWinner && <span className="text-xs font-medium text-indigo-600">Winner</span>
                ) : (
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name={`winner-${round.id}`}
                      checked={winnerId === c.id}
                      onChange={() => setWinnerId(c.id)}
                      className="accent-indigo-600"
                    />
                    Pick as winner
                  </label>
                )}
              </div>
              <AudioPlayer src={c.audioPath} compact />
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                {RATING_DIMS.map((dim) => (
                  <div key={dim.key}>
                    <p className="text-xs text-gray-500 mb-1">{dim.label}</p>
                    {revealed ? (
                      <p className="text-sm tabular-nums text-gray-800">{r?.[dim.key] ?? "–"} / 5</p>
                    ) : (
                      <RatingInput value={r?.[dim.key]} onChange={(v) => setRating(c.id, dim.key, v)} />
                    )}
                  </div>
                ))}
              </div>
              {revealed ? (
                <div className="mt-3 pt-3 border-t border-gray-100 space-y-1">
                  <CandidateReveal c={c} />
                  {existingVote?.candidateNotes?.[c.id] && (
                    <p className="text-sm text-gray-600">
                      <span className="text-xs text-gray-400 mr-2">note</span>
                      {existingVote.candidateNotes[c.id]}
                    </p>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={candidateNotes[c.id] ?? ""}
                  onChange={(e) => setCandidateNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  placeholder="Note on this track, e.g. accent: Southern drawl; want neutral American"
                  className="mt-3 w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                />
              )}
            </div>
          );
        })}
      </div>

      {revealed ? (
        <div className="space-y-3">
          {existingVote?.notes && (
            <p className="text-sm text-gray-600">
              <span className="text-xs text-gray-400 mr-2">notes</span>
              {existingVote.notes}
            </p>
          )}
          {!winner && <p className="text-sm text-gray-500">No preference recorded</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onNewRoundSameText}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              New round with the same text
            </button>
            {winner && (
              <button
                type="button"
                onClick={() => onRerunWinner(winner)}
                className="px-4 py-2 text-sm bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors"
              >
                Re-run winner with 3 seeds (stability)
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="radio"
              name={`winner-${round.id}`}
              checked={winnerId === null}
              onChange={() => setWinnerId(null)}
              className="accent-indigo-600"
            />
            No preference / all rejected
          </label>
          {/* Round-level notes were removed from the UI: a remark belongs to one track so it
              exports with that track. The field is still stored (empty) for compatibility. */}
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={winnerId === undefined || submitting}
              className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Saving..." : "Submit vote & reveal"}
            </button>
            {!ratingsComplete && (
              <span className="text-xs text-gray-400">Ratings are optional; incomplete ones are dropped.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ArenaPanel() {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [presets, setPresets] = useState<VoiceStylePreset[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [rows, setRows] = useState<VariantRow[]>(DEFAULT_VARIANTS.map((instruct) => newRow({ instruct })));
  const [sameSeed, setSameSeed] = useState(false);
  const [presetPick, setPresetPick] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [rounds, setRounds] = useState<ArenaRound[]>([]);
  const [votes, setVotes] = useState<ArenaVote[]>([]);
  const [currentRoundId, setCurrentRoundId] = useState<string | null>(null);
  const [tab, setTab] = useState<"arena" | "leaderboard">("arena");
  const [statsKey, setStatsKey] = useState(0);
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  const [bank, setBank] = useState<{ id: string; label: string; lines: number }[]>([]);
  const [category, setCategory] = useState("any");
  const [sampleN, setSampleN] = useState(2);
  const [sampleProfile, setSampleProfile] = useState("random");
  const [manualOpen, setManualOpen] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [duelOn, setDuelOn] = useState(false);
  const [duelA, setDuelA] = useState("");
  const [duelB, setDuelB] = useState("");
  const [modelsKey, setModelsKey] = useState(0);

  const loadModels = useCallback(async () => {
    try {
      const r = await fetch("/api/models", { cache: "no-store" });
      if (!r.ok) return;
      const list = (await r.json()) as ModelEntry[];
      setModels(list);
      const active = list.find((m) => m.active)?.id ?? list[0]?.id ?? "";
      const tuned = [...list.filter((m) => m.kind === "finetuned")].sort((x, y) => (y.createdAt ?? "").localeCompare(x.createdAt ?? ""));
      const other = tuned.find((m) => m.id !== active)?.id ?? list.find((m) => m.id !== active)?.id ?? "";
      setDuelA((cur) => (cur && list.some((m) => m.id === cur) ? cur : active));
      setDuelB((cur) => (cur && list.some((m) => m.id === cur) ? cur : other));
    } catch {
      /* duel controls stay hidden without a model list */
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/tts/health", { cache: "no-store" });
      setHealth((await r.json()) as HealthInfo);
    } catch {
      setHealth({ reachable: false });
    }
  }, []);

  const votesByRound = useMemo(() => {
    const m = new Map<string, ArenaVote>();
    for (const v of votes) if (!m.has(v.roundId)) m.set(v.roundId, v);
    return m;
  }, [votes]);

  const loadHistory = useCallback(async () => {
    const [r, v] = await Promise.all([
      fetch("/api/arena/rounds", { cache: "no-store" }).then((x) => x.json()),
      fetch("/api/arena/votes", { cache: "no-store" }).then((x) => x.json()),
    ]);
    setRounds(r);
    setVotes(v);
  }, []);

  useEffect(() => {
    fetch("/api/tts/profiles")
      .then((r) => r.json())
      .then((list: VoiceProfile[]) => {
        setProfiles(list);
        const usable = list.find((p) => p.promptAudioPath);
        if (usable) setProfileId(usable.id);
      });
    fetch("/api/presets")
      .then((r) => r.json())
      .then(setPresets);
    fetch("/api/arena/bank")
      .then((r) => r.json())
      .then(setBank)
      .catch(() => setBank([]));
    fetch("/api/tts/health", { cache: "no-store" })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ reachable: false }));
    loadHistory();
    loadModels();
  }, [loadHistory, loadModels]);

  function updateRow(key: string, patch: Partial<ArenaVariant>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addPreset() {
    const p = presets.find((x) => x.id === presetPick);
    if (!p) return;
    setRows((prev) => [...prev, newRow({ instruct: p.instruct, speed: p.speed, presetId: p.id })]);
    setPresetPick("");
  }

  function toggleSameSeed(on: boolean) {
    setSameSeed(on);
    if (on) {
      const s = randomSeed();
      setRows((prev) => prev.map((r) => ({ ...r, seed: s })));
    } else {
      setRows((prev) => prev.map((r) => ({ ...r, seed: undefined })));
    }
  }

  async function generate(variants: ArenaVariant[], lineText: string) {
    if (!profileId || !lineText.trim()) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/arena/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, text: lineText, variants }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      const round = data as ArenaRound;
      setRounds((prev) => [round, ...prev]);
      setCurrentRoundId(round.id);
      setTab("arena");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function rollRound() {
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/arena/random", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          duelOn && duelA && duelB && duelA !== duelB
            ? { category, profileId: sampleProfile, duel: { models: [duelA, duelB] } }
            : { category, n: sampleN, profileId: sampleProfile }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sampling failed");
      const round = data as ArenaRound;
      setRounds((prev) => [round, ...prev]);
      setCurrentRoundId(round.id);
      setTab("arena");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sampling failed");
    } finally {
      setGenerating(false);
    }
  }

  function generateFromRows() {
    const variants: ArenaVariant[] = rows.map(({ instruct, speed, seed, presetId }) => ({
      instruct: instruct.trim(),
      speed,
      seed: seed ?? undefined,
      presetId,
    }));
    generate(variants, text);
  }

  function rerunWinner(winner: ArenaCandidate, lineText: string) {
    const variants: ArenaVariant[] = [0, 1, 2].map(() => ({
      instruct: winner.instruct,
      speed: winner.speed,
      seed: randomSeed(),
      presetId: winner.presetId,
    }));
    generate(variants, lineText);
  }

  function onVoted(vote: ArenaVote) {
    setVotes((prev) => [vote, ...prev]);
    setStatsKey((k) => k + 1);
  }

  const currentRound = rounds.find((r) => r.id === currentRoundId) ?? null;
  const activeModel = health?.model ?? null;
  // Rounds are partitioned by the model that made them, like the leaderboard: history shows
  // the current model's rounds (duels count for either participant) unless "show all" is on.
  const visibleRounds = rounds.filter(
    (r) =>
      showAllModels ||
      !activeModel ||
      (r.model ?? "unknown") === activeModel ||
      (r.trial === "duel" && (r.models ?? []).includes(activeModel))
  );
  const selectedProfile = profiles.find((p) => p.id === profileId);
  const canGenerate =
    !!profileId && !!selectedProfile?.promptAudioPath && text.trim().length > 0 && rows.length >= 2 && rows.length <= 6 && !generating;

  const healthChip = health === null
    ? { text: "backend: checking…", cls: "bg-gray-100 text-gray-500" }
    : !health.reachable
    ? { text: "backend unreachable", cls: "bg-red-50 text-red-700 border-red-200" }
    : health.ready
    ? { text: `${health.model ?? "model"} · ready`, cls: "bg-green-50 text-green-700 border-green-200" }
    : { text: `${health.model ?? "model"} · ${health.loading ? "loading" : "not loaded (loads on first request)"}`, cls: "bg-amber-50 text-amber-700 border-amber-200" };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Arena</h2>
          <p className="text-sm text-gray-500 mt-1">
            One line, several prosody instructions, blind listening. Each vote is stored as preference data (chosen / rejected).
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-xs px-2.5 py-1 rounded-full border ${healthChip.cls}`}>{healthChip.text}</span>
          <ModelSwitch
            refreshKey={modelsKey}
            onSwitched={() => {
              refreshHealth();
              setModelsKey((k) => k + 1);
              loadModels();
            }}
          />
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {(["arena", "leaderboard"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${
              tab === t ? "border-indigo-600 text-indigo-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "arena" ? "Arena" : "Leaderboard"}
          </button>
        ))}
      </div>

      {tab === "leaderboard" ? (
        <ArenaLeaderboard refreshKey={statsKey} />
      ) : (
        <>
          <div className="bg-white border border-indigo-200 rounded-xl p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900">🎲 Sampled round</h3>
              <p className="text-xs text-gray-500 mt-1">
                The line is drawn from a bank by category, the instructions from the English presets (pure clone included) with
                under-tested ones favoured, and all candidates share one seed. You only listen and pick.
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1">Category</p>
              <div className="flex flex-wrap gap-2">
                {[{ id: "any", label: "Any", lines: 0 }, ...bank].map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCategory(c.id)}
                    className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                      category === c.id ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-700 border-gray-300 hover:border-indigo-400"
                    }`}
                  >
                    {c.label}
                    {c.lines ? <span className="ml-1 opacity-60">{c.lines}</span> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Candidates</label>
                <div className="flex gap-1">
                  {[2, 3, 4].map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSampleN(k)}
                      className={`w-9 h-8 rounded-md text-sm border ${sampleN === k ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-56">
                <label className="block text-xs font-medium text-gray-600 mb-1">Voice profile</label>
                <select
                  value={sampleProfile}
                  onChange={(e) => setSampleProfile(e.target.value)}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="random">Random prepared profile</option>
                  {profiles.filter((p) => p.promptAudioPath).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={rollRound}
                disabled={generating || profiles.every((p) => !p.promptAudioPath) || (duelOn && (!duelA || !duelB || duelA === duelB))}
                className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? "Generating…" : duelOn ? "⚔ Roll a duel" : "🎲 Roll a round"}
              </button>
            </div>
            {models.length > 1 && (
              <div className="border-t border-gray-100 pt-3 space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={duelOn} onChange={(e) => setDuelOn(e.target.checked)} className="accent-indigo-600" />
                  ⚔ Duel two checkpoints
                  <span className="text-xs text-gray-500">— same line, same instruction, same seed; only the model differs. The backend swaps models for each candidate, so a duel takes longer.</span>
                </label>
                {duelOn && (
                  <div className="flex flex-wrap items-end gap-4">
                    {([["A", duelA, setDuelA], ["B", duelB, setDuelB]] as const).map(([label, value, set]) => (
                      <div key={label} className="min-w-56">
                        <label className="block text-xs font-medium text-gray-600 mb-1">Checkpoint {label}</label>
                        <select value={value} onChange={(e) => set(e.target.value)} className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm">
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.kind === "finetuned" ? `★ ${m.name}` : m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {duelA === duelB && <span className="text-xs text-red-600">pick two different checkpoints</span>}
                  </div>
                )}
              </div>
            )}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setManualOpen((o) => !o)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            {manualOpen ? "▾ Hide manual variants" : "▸ Manual variants (write your own instructions, advanced)"}
          </button>

          {manualOpen && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Voice profile</label>
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select a voice...</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.promptAudioPath}>
                      {p.name}
                      {!p.promptAudioPath ? " (not prepared)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="lg:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-gray-700">Test line</label>
                  <div className="flex gap-1">
                    {SAMPLE_LINES.map((s) => (
                      <button key={s.label} type="button" onClick={() => setText(s.text)} className="text-xs px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50">
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 resize-y"
                />
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <label className="text-sm font-medium text-gray-700">Variants (2–6)</label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={presetPick}
                    onChange={(e) => setPresetPick(e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-xs"
                  >
                    <option value="">Add from preset…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.language === "zh" ? " · 中文" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addPreset}
                    disabled={!presetPick || rows.length >= 6}
                    className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setRows((prev) => [...prev, newRow({ seed: sameSeed ? prev[0]?.seed : undefined })])}
                    disabled={rows.length >= 6}
                    className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    + blank
                  </button>
                  <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={sameSeed} onChange={(e) => toggleSameSeed(e.target.checked)} className="accent-indigo-600" />
                    Same seed for all
                  </label>
                </div>
              </div>
              <div className="space-y-2">
                {rows.map((row, i) => (
                  <div key={row.key} className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 items-center">
                    <span className="text-xs text-gray-400 w-5 tabular-nums">{i + 1}</span>
                    <input
                      type="text"
                      value={row.instruct}
                      onChange={(e) => updateRow(row.key, { instruct: e.target.value, presetId: undefined })}
                      placeholder='Instruction. Leave empty for a pure clone. e.g. "Speak slowly and warmly." / "Sound surprised."'
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                    />
                    <label className="flex items-center gap-1 text-xs text-gray-500">
                      <span className="tabular-nums w-10">{row.speed.toFixed(2)}×</span>
                      <input
                        type="range"
                        min="0.7"
                        max="1.3"
                        step="0.05"
                        value={row.speed}
                        onChange={(e) => updateRow(row.key, { speed: parseFloat(e.target.value) })}
                        className="w-24 accent-indigo-600"
                      />
                    </label>
                    <input
                      type="number"
                      value={row.seed ?? ""}
                      onChange={(e) => updateRow(row.key, { seed: e.target.value === "" ? undefined : parseInt(e.target.value, 10) })}
                      placeholder="seed"
                      disabled={sameSeed}
                      className="w-28 px-2 py-1.5 border border-gray-300 rounded-lg text-xs tabular-nums disabled:bg-gray-50"
                    />
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                      disabled={rows.length <= 2}
                      className="text-gray-400 hover:text-red-500 disabled:opacity-30 px-1"
                      aria-label="remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

            <button
              type="button"
              onClick={generateFromRows}
              disabled={!canGenerate}
              className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {generating ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generating {rows.length} candidates…
                </span>
              ) : (
                "Generate round"
              )}
            </button>
          </div>
          )}

          {currentRound && (
            <div className="bg-white border border-indigo-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Current round · {new Date(currentRound.createdAt).toLocaleString()}
                {currentRound.category && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-normal">{currentRound.category}</span>
                )}
                {currentRound.sampled && <span className="ml-1 text-xs font-normal text-gray-400">sampled</span>}
                {/* Trial type is shown only once the vote is in: revealing a repeat or anchor beforehand would unblind it. */}
                {votesByRound.has(currentRound.id) && <TrialBadge trial={currentRound.trial} />}
              </h3>
              <RoundVoting
                key={currentRound.id}
                round={currentRound}
                existingVote={votesByRound.get(currentRound.id) ?? null}
                onVoted={onVoted}
                onRerunWinner={(w) => rerunWinner(w, currentRound.text)}
                onNewRoundSameText={() => {
                  setText(currentRound.text);
                  generateFromRows();
                }}
              />
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-700">
              History ({visibleRounds.length})
              {activeModel && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {showAllModels ? "all models" : `made with ${shortModelName(activeModel)}`}
                  <button type="button" onClick={() => setShowAllModels((v) => !v)} className="ml-2 text-indigo-600 hover:underline">
                    {showAllModels ? "only current model" : `show all (${rounds.length})`}
                  </button>
                </span>
              )}
            </h3>
            {visibleRounds.length === 0 && (
              <p className="text-sm text-gray-400">
                {rounds.length === 0 ? "No rounds yet." : "No rounds made with the current model yet. Roll one, or show all."}
              </p>
            )}
            {visibleRounds
              .filter((r) => r.id !== currentRoundId)
              .map((r) => {
                const v = votesByRound.get(r.id) ?? null;
                const open = !!openHistory[r.id];
                return (
                  <div key={r.id} className="border border-gray-200 rounded-xl bg-white">
                    <button
                      type="button"
                      onClick={() => setOpenHistory((prev) => ({ ...prev, [r.id]: !open }))}
                      className="w-full flex items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-sm text-gray-800 truncate">
                        <span className="text-xs text-gray-400 mr-2">{new Date(r.createdAt).toLocaleString()}</span>
                        {r.category && <span className="mr-2 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-xs">{r.category}</span>}
                        {v && r.trial && r.trial !== "test" && (
                          <span className={`mr-2 px-1.5 py-0.5 rounded text-xs ${r.trial === "repeat" ? "bg-amber-50 text-amber-700" : r.trial === "duel" ? "bg-purple-50 text-purple-700" : r.trial === "seed" ? "bg-sky-50 text-sky-700" : "bg-emerald-50 text-emerald-700"}`}>{r.trial}</span>
                        )}
                        {r.text}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${v ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                        {v ? `voted · ${r.candidates.length}` : `unvoted · ${r.candidates.length}`}
                      </span>
                    </button>
                    {open && (
                      <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                        {v ? (
                          <RoundVoting
                            round={r}
                            existingVote={v}
                            onVoted={onVoted}
                            onRerunWinner={(w) => rerunWinner(w, r.text)}
                            onNewRoundSameText={() => {
                              setText(r.text);
                              generateFromRows();
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setCurrentRoundId(r.id)}
                            className="px-4 py-2 text-sm bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-100"
                          >
                            Open for voting
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}
