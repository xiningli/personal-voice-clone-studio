// Bradley-Terry ranking with bootstrap confidence intervals, and rater reliability
// (docs/protocol.md §2). Pure functions; no I/O.

import type { ArenaRound, ArenaVote, BradleyTerryEntry, DuelStats, RaterReliability, TrialType } from "./types";

export interface BTOptions {
  /** Partition key; "all" pools every model. */
  model?: string;
  excludeTrials?: TrialType[];
  bootstrap?: number;
  seed?: number;
  maxIter?: number;
}

/** mulberry32: tiny seeded PRNG so bootstrap CIs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Match {
  winner: string; // instruct
  loser: string;
}

function decidedMatches(rounds: ArenaRound[], votes: ArenaVote[], opts: BTOptions): Match[] {
  const roundsById = new Map(rounds.map((r) => [r.id, r]));
  const exclude = new Set(opts.excludeTrials ?? ["seed", "repeat", "anchor", "duel"]);
  const matches: Match[] = [];
  for (const vote of votes) {
    const round = roundsById.get(vote.roundId);
    if (!round || !vote.winnerId) continue;
    if (exclude.has(round.trial ?? "test")) continue;
    if (opts.model && opts.model !== "all" && (round.model ?? "unknown") !== opts.model) continue;
    const winner = round.candidates.find((c) => c.id === vote.winnerId);
    if (!winner) continue;
    for (const loser of round.candidates) {
      if (loser.id === winner.id || loser.instruct === winner.instruct) continue;
      matches.push({ winner: winner.instruct, loser: loser.instruct });
    }
  }
  return matches;
}

/**
 * Bradley-Terry MLE by the MM (Zermelo) iteration: p_i <- w_i / sum_j n_ij / (p_i + p_j).
 * Returns mean-centred log-strengths. Items with no matches get 0 (undefined strength).
 * A small Laplace prior (0.5 pseudo-win each way against a virtual opponent) keeps the
 * estimate finite when an item has only wins or only losses.
 */
export function bradleyTerry(items: string[], matches: Match[], maxIter = 500): Map<string, number> {
  const idx = new Map(items.map((it, i) => [it, i]));
  const n = items.length;
  const wins = new Array<number>(n).fill(0);
  const pairs = new Map<string, number>(); // "i,j" -> games between i and j
  for (const m of matches) {
    const i = idx.get(m.winner);
    const j = idx.get(m.loser);
    if (i === undefined || j === undefined) continue;
    wins[i] += 1;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  // Virtual opponent with fixed strength 1: half a win and half a loss for every item.
  const prior = 0.5;
  const p = new Array<number>(n).fill(1);
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    const next = new Array<number>(n).fill(1);
    for (let i = 0; i < n; i++) {
      let denom = (2 * prior) / (p[i] + 1); // games vs the virtual opponent
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        const g = pairs.get(key);
        if (!g) continue;
        denom += g / (p[i] + p[j]);
      }
      next[i] = (wins[i] + prior) / denom;
      maxDelta = Math.max(maxDelta, Math.abs(Math.log(next[i]) - Math.log(p[i])));
    }
    const geo = Math.exp(next.reduce((s, v) => s + Math.log(v), 0) / n);
    for (let i = 0; i < n; i++) p[i] = next[i] / geo;
    if (maxDelta < 1e-6) break;
  }
  return new Map(items.map((it, i) => [it, Math.log(p[i])]));
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 1000) / 1000;
}

export function fitBradleyTerry(rounds: ArenaRound[], votes: ArenaVote[], opts: BTOptions = {}): BradleyTerryEntry[] {
  const modelRounds = rounds.filter((r) => !opts.model || opts.model === "all" || (r.model ?? "unknown") === opts.model);
  // seed rounds compare two samples of one instruction, so they carry no information about
  // which instruction is better; they are DPO data, not ranking data.
  const exclude = new Set(opts.excludeTrials ?? ["seed", "repeat", "anchor", "duel"]);
  const testRounds = modelRounds.filter((r) => !exclude.has(r.trial ?? "test"));
  const matches = decidedMatches(modelRounds, votes, opts);

  const items = [...new Set(testRounds.flatMap((r) => r.candidates.filter((c) => !c.isRecording).map((c) => c.instruct)))];
  if (items.length === 0) return [];
  const strengths = bradleyTerry(items, matches, opts.maxIter);

  // Bootstrap over votes (matches grouped by vote would be more exact; matches are the
  // unit here because a 2-candidate round yields exactly one match).
  const B = opts.bootstrap ?? 1000;
  const rng = mulberry32(opts.seed ?? 20260915);
  const samples = new Map<string, number[]>(items.map((it) => [it, []]));
  if (matches.length > 0 && B > 0) {
    for (let b = 0; b < B; b++) {
      const resampled: Match[] = [];
      for (let k = 0; k < matches.length; k++) resampled.push(matches[Math.floor(rng() * matches.length)]);
      const s = bradleyTerry(items, resampled, 200);
      for (const it of items) samples.get(it)!.push(s.get(it) ?? 0);
    }
  }

  const roundsById = new Map(modelRounds.map((r) => [r.id, r]));
  const acc = new Map<
    string,
    { presetId?: string; wins: number; losses: number; rounds: Set<string>; nat: number[]; emo: number[]; sim: number[]; wer: number[]; ss: number[] }
  >();
  const get = (it: string) => {
    let a = acc.get(it);
    if (!a) {
      a = { wins: 0, losses: 0, rounds: new Set(), nat: [], emo: [], sim: [], wer: [], ss: [] };
      acc.set(it, a);
    }
    return a;
  };
  for (const r of testRounds) {
    for (const c of r.candidates) {
      if (c.isRecording) continue;
      const a = get(c.instruct);
      a.rounds.add(r.id);
      if (!a.presetId && c.presetId) a.presetId = c.presetId;
      if (c.metrics?.wer != null) a.wer.push(c.metrics.wer);
      if (c.metrics?.speakerSimilarity != null) a.ss.push(c.metrics.speakerSimilarity);
    }
  }
  for (const m of matches) {
    get(m.winner).wins += 1;
    get(m.loser).losses += 1;
  }
  for (const v of votes) {
    const r = roundsById.get(v.roundId);
    if (!r || exclude.has(r.trial ?? "test")) continue;
    for (const c of r.candidates) {
      const rt = v.ratings[c.id];
      if (!rt || c.isRecording) continue;
      const a = get(c.instruct);
      a.nat.push(rt.naturalness);
      a.emo.push(rt.emotion);
      a.sim.push(rt.similarity);
    }
  }

  const entries: BradleyTerryEntry[] = items.map((it) => {
    const a = get(it);
    const s = samples.get(it) ?? [];
    const sorted = [...s].sort((x, y) => x - y);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    const score = strengths.get(it) ?? 0;
    return {
      instruct: it,
      presetId: a.presetId,
      score: Math.round(score * 1000) / 1000,
      ci95: sorted.length ? [Math.round(q(0.025) * 1000) / 1000, Math.round(q(0.975) * 1000) / 1000] : [score, score],
      wins: a.wins,
      losses: a.losses,
      rounds: a.rounds.size,
      avgNaturalness: mean(a.nat),
      avgEmotion: mean(a.emo),
      avgSimilarity: mean(a.sim),
      avgWer: mean(a.wer),
      avgSpeakerSimilarity: mean(a.ss),
    };
  });
  return entries.sort((x, y) => y.score - x.score);
}

export function raterReliability(rounds: ArenaRound[], votes: ArenaVote[], model?: string): RaterReliability {
  const inModel = (r: ArenaRound) => !model || model === "all" || (r.model ?? "unknown") === model;
  const roundsById = new Map(rounds.map((r) => [r.id, r]));
  const voteByRound = new Map<string, ArenaVote>();
  for (const v of votes) if (!voteByRound.has(v.roundId)) voteByRound.set(v.roundId, v);

  const winningInstruct = (round: ArenaRound, vote: ArenaVote | undefined): string | null => {
    if (!vote?.winnerId) return null;
    return round.candidates.find((c) => c.id === vote.winnerId)?.instruct ?? null;
  };

  let repeatTrials = 0;
  let repeatAgree = 0;
  let anchorTrials = 0;
  let anchorCorrect = 0;
  for (const r of rounds) {
    if (!inModel(r)) continue;
    const v = voteByRound.get(r.id);
    if (!v) continue;
    if (r.trial === "repeat" && r.repeatOf) {
      const orig = roundsById.get(r.repeatOf);
      const ov = orig ? voteByRound.get(orig.id) : undefined;
      if (!orig || !ov) continue;
      const a = winningInstruct(r, v);
      const b = winningInstruct(orig, ov);
      repeatTrials += 1;
      if (a !== null && a === b) repeatAgree += 1;
      else if (a === null && b === null) repeatAgree += 1; // both "no preference"
    } else if (r.trial === "anchor") {
      const rec = r.candidates.find((c) => c.isRecording);
      if (!rec) continue;
      anchorTrials += 1;
      // "Won on similarity": the recording is picked, or it gets the higher similarity rating.
      const recSim = v.ratings[rec.id]?.similarity;
      const others = r.candidates.filter((c) => c.id !== rec.id).map((c) => v.ratings[c.id]?.similarity ?? -1);
      const bySim = recSim !== undefined && others.every((s) => recSim > s);
      if (v.winnerId === rec.id || bySim) anchorCorrect += 1;
    }
  }
  return {
    repeatTrials,
    repeatAgreement: repeatTrials ? Math.round((repeatAgree / repeatTrials) * 1000) / 1000 : null,
    anchorTrials,
    anchorAccuracy: anchorTrials ? Math.round((anchorCorrect / anchorTrials) * 1000) / 1000 : null,
  };
}


/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, Math.round((centre - half) * 1000) / 1000), Math.min(1, Math.round((centre + half) * 1000) / 1000)];
}

function meanOf(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
}

/**
 * Pairwise checkpoint comparison over duel trials (docs/protocol.md §2): same line,
 * instruction and seed, only the model differs. Each unordered pair of models gets its own
 * row; winRateA is the share of decided duels won by models[0] with a Wilson 95 % CI.
 */
export function modelDuels(rounds: ArenaRound[], votes: ArenaVote[]): DuelStats[] {
  const voteByRound = new Map<string, ArenaVote>();
  for (const v of votes) if (!voteByRound.has(v.roundId)) voteByRound.set(v.roundId, v);
  const byPair = new Map<string, { models: [string, string]; rounds: ArenaRound[] }>();
  for (const r of rounds) {
    if (r.trial !== "duel") continue;
    const ids = (r.models && r.models.length === 2 ? r.models : [...new Set(r.candidates.map((c) => c.model ?? "unknown"))]).slice(0, 2);
    if (ids.length !== 2) continue;
    const pair = [...ids].sort() as [string, string];
    const key = pair.join("\u0000");
    const entry = byPair.get(key) ?? { models: pair, rounds: [] };
    entry.rounds.push(r);
    byPair.set(key, entry);
  }
  const out: DuelStats[] = [];
  for (const { models, rounds: rs } of byPair.values()) {
    const [a, b] = models;
    let decided = 0;
    let winsA = 0;
    let winsB = 0;
    let ties = 0;
    const ratings: Record<string, { naturalness: number[]; emotion: number[]; similarity: number[] }> = {
      [a]: { naturalness: [], emotion: [], similarity: [] },
      [b]: { naturalness: [], emotion: [], similarity: [] },
    };
    const wer: Record<string, (number | null | undefined)[]> = { [a]: [], [b]: [] };
    const sim: Record<string, (number | null | undefined)[]> = { [a]: [], [b]: [] };
    for (const r of rs) {
      for (const c of r.candidates) {
        const m = c.model ?? "unknown";
        if (!(m in wer)) continue;
        wer[m].push(c.metrics?.wer);
        sim[m].push(c.metrics?.speakerSimilarity);
      }
      const v = voteByRound.get(r.id);
      if (!v) continue;
      for (const c of r.candidates) {
        const m = c.model ?? "unknown";
        const rt = v.ratings[c.id];
        if (!rt || !(m in ratings)) continue;
        ratings[m].naturalness.push(rt.naturalness);
        ratings[m].emotion.push(rt.emotion);
        ratings[m].similarity.push(rt.similarity);
      }
      if (!v.winnerId) {
        ties += 1;
        continue;
      }
      const winner = r.candidates.find((c) => c.id === v.winnerId);
      if (!winner?.model) continue;
      decided += 1;
      if (winner.model === a) winsA += 1;
      else if (winner.model === b) winsB += 1;
    }
    out.push({
      models,
      rounds: rs.length,
      decided,
      winsA,
      winsB,
      ties,
      winRateA: decided ? Math.round((winsA / decided) * 1000) / 1000 : null,
      ci95: wilson(winsA, decided),
      meanRatingsByModel: Object.fromEntries(
        [a, b].map((m) => [m, { naturalness: meanOf(ratings[m].naturalness), emotion: meanOf(ratings[m].emotion), similarity: meanOf(ratings[m].similarity) }])
      ),
      meanWerByModel: Object.fromEntries([a, b].map((m) => [m, meanOf(wer[m])])),
      meanSpkSimByModel: Object.fromEntries([a, b].map((m) => [m, meanOf(sim[m])])),
    });
  }
  return out.sort((x, y) => y.rounds - x.rounds);
}
