"use client";

import { useEffect, useState } from "react";
import type { BradleyTerryEntry, DuelStats, InstructStats, RaterReliability } from "@/lib/types";
import { shortModelName } from "./ModelSwitch";

interface StatsResponse {
  model: string;
  models: string[];
  totalRounds: number;
  totalVotes: number;
  trials?: Record<string, number>;
  stats: InstructStats[];
  bt?: BradleyTerryEntry[];
  reliability?: RaterReliability;
  duels?: DuelStats[];
  bootstrap?: number;
}

function modelLabel(id: string): string {
  const tuned = id.startsWith("/") || id.includes("/models/");
  return `${tuned ? "★ " : ""}${shortModelName(id)}`;
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "–" : v.toFixed(digits);
}

function pct(v: number | null): string {
  return v === null ? "–" : `${Math.round(v * 100)}%`;
}

export default function ArenaLeaderboard({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [showElo, setShowElo] = useState(false);

  useEffect(() => {
    fetch(`/api/arena/stats?model=${encodeURIComponent(model)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load stats"));
  }, [refreshKey, model]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Leaderboard</h3>
          {data && (
            <p className="text-xs text-gray-500 mt-0.5">
              {data.totalRounds} rounds
              {data.trials && ` (${data.trials.test ?? 0} test · ${data.trials.repeat ?? 0} repeat · ${data.trials.anchor ?? 0} anchor)`} ·{" "}
              {data.totalVotes} votes · Bradley-Terry MLE, {data.bootstrap ?? 1000}-sample bootstrap 95% CI
            </p>
          )}
          {data && data.models.length > 0 && (
            <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
              Model
              <select
                value={data.model}
                onChange={(e) => setModel(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded-md text-xs bg-white"
              >
                {data.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                {data.models.length > 1 && <option value="all">all models (pooled)</option>}
              </select>
            </label>
          )}
        </div>
        <div className="flex gap-2">
          <a
            href="/api/arena/export"
            className="px-3 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Download preference-pairs.jsonl
          </a>
          <a
            href="/api/arena/export/digital-human"
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 text-sm bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors"
          >
            Digital-human export
          </a>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {data && (data.bt?.length ?? 0) === 0 ? (
        <div className="text-center py-10 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-500">
          No decided test trials yet. Roll a round and pick a winner to populate the ranking.
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-xl bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Instruction</th>
                <th className="text-right px-3 py-2" title="Bradley-Terry log-strength, mean-centred; higher is preferred">BT score [95% CI]</th>
                <th className="text-right px-3 py-2">W / L</th>
                <th className="text-right px-3 py-2">Rounds</th>
                <th className="text-right px-3 py-2">Natural</th>
                <th className="text-right px-3 py-2">Emotion</th>
                <th className="text-right px-3 py-2">Like me</th>
                <th className="text-right px-3 py-2" title="faster-whisper transcript vs the line">WER</th>
                <th className="text-right px-3 py-2" title="CAM++ x-vector cosine vs the profile prompt">Spk-sim</th>
              </tr>
            </thead>
            <tbody>
              {data?.bt?.map((e, i) => {
                const wide = e.ci95[1] - e.ci95[0] > 2;
                return (
                  <tr key={e.instruct || "__neutral__"} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2 max-w-md">
                      <span className={e.instruct ? "text-gray-900" : "italic text-gray-500"}>
                        {e.instruct || "(neutral — no instruct)"}
                      </span>
                      {e.presetId && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">
                          {e.presetId}
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${wide ? "text-gray-400" : "font-semibold"}`} title={wide ? "Wide interval: too few decided rounds to separate this instruction" : undefined}>
                      {fmt(e.score, 2)} <span className="text-xs text-gray-400">[{fmt(e.ci95[0], 1)}, {fmt(e.ci95[1], 1)}]</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.wins} / {e.losses}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.rounds}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(e.avgNaturalness)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(e.avgEmotion)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(e.avgSimilarity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(e.avgWer, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(e.avgSpeakerSimilarity, 3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data?.reliability && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="border border-gray-200 rounded-xl bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">Repeat agreement</p>
            <p className="text-2xl font-semibold tabular-nums text-gray-900 mt-1">
              {pct(data.reliability.repeatAgreement)}
              <span className="ml-2 text-sm font-normal text-gray-400">
                {Math.round((data.reliability.repeatAgreement ?? 0) * data.reliability.repeatTrials)}/{data.reliability.repeatTrials}
              </span>
            </p>
            <p className="text-xs text-gray-500 mt-1">
              How often you picked the same instruction when a pair you already judged was re-served under fresh labels (test-retest reliability).
            </p>
          </div>
          <div className="border border-gray-200 rounded-xl bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">Anchor accuracy</p>
            <p className="text-2xl font-semibold tabular-nums text-gray-900 mt-1">
              {pct(data.reliability.anchorAccuracy)}
              <span className="ml-2 text-sm font-normal text-gray-400">
                {Math.round((data.reliability.anchorAccuracy ?? 0) * data.reliability.anchorTrials)}/{data.reliability.anchorTrials}
              </span>
            </p>
            <p className="text-xs text-gray-500 mt-1">
              How often a real recording of you beat the synthesized candidate on similarity. Anchors only appear once accepted takes exist in the corpus.
            </p>
          </div>
        </div>
      )}

      {data && (
        <div className="border border-gray-200 rounded-xl bg-white p-4 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">Checkpoint duels</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              Same line, same instruction, same seed; only the checkpoint differs. Win rate of A with a Wilson 95 % CI, plus mean ratings and objective metrics per model. Never mixed into the instruction table above.
            </p>
          </div>
          {!data.duels || data.duels.length === 0 ? (
            <p className="text-sm text-gray-400">No duels yet. Tick “Duel two checkpoints” in the Arena and roll.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2">A vs B</th>
                    <th className="text-right px-3 py-2">Rounds</th>
                    <th className="text-right px-3 py-2">A wins / B wins / ties</th>
                    <th className="text-right px-3 py-2">A win rate [95% CI]</th>
                    <th className="text-right px-3 py-2">Natural A / B</th>
                    <th className="text-right px-3 py-2">Emotion A / B</th>
                    <th className="text-right px-3 py-2">Like me A / B</th>
                    <th className="text-right px-3 py-2">WER A / B</th>
                    <th className="text-right px-3 py-2">Spk-sim A / B</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.duels.map((d) => {
                    const [a, b] = d.models;
                    const ra = d.meanRatingsByModel[a];
                    const rb = d.meanRatingsByModel[b];
                    return (
                      <tr key={a + b}>
                        <td className="px-3 py-2">
                          <div title={a}>{modelLabel(a)}</div>
                          <div className="text-xs text-gray-400" title={b}>vs {modelLabel(b)}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{d.rounds}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{d.winsA} / {d.winsB} / {d.ties}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {d.winRateA === null ? "–" : `${Math.round(d.winRateA * 100)}%`}
                          {d.ci95 && <span className="text-xs text-gray-400 ml-1">[{Math.round(d.ci95[0] * 100)}, {Math.round(d.ci95[1] * 100)}]</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(ra?.naturalness)} / {fmt(rb?.naturalness)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(ra?.emotion)} / {fmt(rb?.emotion)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(ra?.similarity)} / {fmt(rb?.similarity)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(d.meanWerByModel[a])} / {fmt(d.meanWerByModel[b])}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(d.meanSpkSimByModel[a], 3)} / {fmt(d.meanSpkSimByModel[b], 3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {data && data.stats.length > 0 && (
        <div className="border border-gray-200 rounded-xl bg-white">
          <button
            type="button"
            onClick={() => setShowElo((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-left text-xs text-gray-500 hover:text-gray-700"
          >
            <span>{showElo ? "▾" : "▸"} Elo live view (K=32, start 1000; includes all trial types)</span>
          </button>
          {showElo && (
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Instruction</th>
                    <th className="text-right px-3 py-2">Elo</th>
                    <th className="text-right px-3 py-2">Rounds</th>
                    <th className="text-right px-3 py-2">W / L / T</th>
                    <th className="text-right px-3 py-2">Win %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stats.map((s, i) => (
                    <tr key={s.instruct || "__neutral__"} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-400 tabular-nums">{i + 1}</td>
                      <td className="px-3 py-2 max-w-md">
                        <span className={s.instruct ? "text-gray-900" : "italic text-gray-500"}>
                          {s.instruct || "(neutral — no instruct)"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.elo}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.rounds}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.wins} / {s.losses} / {s.ties}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round(s.winRate * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
