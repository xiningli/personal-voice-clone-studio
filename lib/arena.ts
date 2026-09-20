import type {
  ArenaCandidate,
  ArenaRound,
  ArenaVote,
  CandidateRating,
  InstructStats,
  PreferencePair,
  PreferenceSide,
} from "./types";

const ELO_K = 32;
const ELO_START = 1000;

interface Accumulator {
  instruct: string;
  presetId?: string;
  rounds: Set<string>;
  wins: number;
  losses: number;
  ties: number;
  elo: number;
  naturalness: number[];
  emotion: number[];
  similarity: number[];
}

function accumulator(instruct: string, presetId?: string): Accumulator {
  return {
    instruct,
    presetId,
    rounds: new Set(),
    wins: 0,
    losses: 0,
    ties: 0,
    elo: ELO_START,
    naturalness: [],
    emotion: [],
    similarity: [],
  };
}

function expectedScore(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

/** Update two Elo ratings in place. score is from a's point of view: 1 win, 0.5 tie, 0 loss. */
function applyElo(a: Accumulator, b: Accumulator, score: number): void {
  const ea = expectedScore(a.elo, b.elo);
  const eb = 1 - ea;
  a.elo += ELO_K * (score - ea);
  b.elo += ELO_K * (1 - score - eb);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

function pushRating(acc: Accumulator, rating: CandidateRating | undefined): void {
  if (!rating) return;
  acc.naturalness.push(rating.naturalness);
  acc.emotion.push(rating.emotion);
  acc.similarity.push(rating.similarity);
}

function byCreatedAt<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Group candidates by instruct string and score them from the votes, in vote order. */
export function computeInstructStats(rounds: ArenaRound[], votes: ArenaVote[]): InstructStats[] {
  const roundsById = new Map(rounds.map((r) => [r.id, r]));
  const stats = new Map<string, Accumulator>();

  const get = (instruct: string, presetId?: string): Accumulator => {
    let acc = stats.get(instruct);
    if (!acc) {
      acc = accumulator(instruct, presetId);
      stats.set(instruct, acc);
    }
    if (!acc.presetId && presetId) acc.presetId = presetId;
    return acc;
  };

  for (const round of rounds) {
    for (const c of round.candidates) get(c.instruct, c.presetId).rounds.add(round.id);
  }

  for (const vote of [...votes].sort(byCreatedAt)) {
    const round = roundsById.get(vote.roundId);
    if (!round) continue;
    for (const c of round.candidates) pushRating(get(c.instruct, c.presetId), vote.ratings[c.id]);

    const winner = vote.winnerId ? round.candidates.find((c) => c.id === vote.winnerId) : undefined;
    if (!winner) {
      // No preference: every pair is a tie.
      for (let i = 0; i < round.candidates.length; i++) {
        for (let j = i + 1; j < round.candidates.length; j++) {
          const a = get(round.candidates[i].instruct);
          const b = get(round.candidates[j].instruct);
          if (a === b) continue;
          a.ties += 1;
          b.ties += 1;
          applyElo(a, b, 0.5);
        }
      }
      continue;
    }

    const w = get(winner.instruct, winner.presetId);
    for (const c of round.candidates) {
      if (c.id === winner.id) continue;
      const l = get(c.instruct, c.presetId);
      if (l === w) continue; // same instruct, different seed: not a preference between instructs
      w.wins += 1;
      l.losses += 1;
      applyElo(w, l, 1);
    }
  }

  return [...stats.values()].map((acc) => {
    const decided = acc.wins + acc.losses;
    return {
      instruct: acc.instruct,
      presetId: acc.presetId,
      rounds: acc.rounds.size,
      wins: acc.wins,
      losses: acc.losses,
      ties: acc.ties,
      winRate: decided === 0 ? 0 : Math.round((acc.wins / decided) * 1000) / 1000,
      elo: Math.round(acc.elo),
      avgNaturalness: mean(acc.naturalness),
      avgEmotion: mean(acc.emotion),
      avgSimilarity: mean(acc.similarity),
    };
  });
}

function side(c: ArenaCandidate, vote: ArenaVote): PreferenceSide {
  return {
    candidateId: c.id,
    label: c.label,
    instruct: c.instruct,
    speed: c.speed,
    seed: c.seed,
    audioPath: c.audioPath,
    note: vote.candidateNotes?.[c.id] ?? "",
    metrics: c.metrics,
    model: c.model,
  };
}

/** One chosen/rejected pair per winner-vs-loser candidate in each decided vote. */
export function buildPreferencePairs(rounds: ArenaRound[], votes: ArenaVote[]): PreferencePair[] {
  const roundsById = new Map(rounds.map((r) => [r.id, r]));
  const pairs: PreferencePair[] = [];

  for (const vote of [...votes].sort(byCreatedAt)) {
    const round = roundsById.get(vote.roundId);
    if (!round || !vote.winnerId) continue;
    const winner = round.candidates.find((c) => c.id === vote.winnerId);
    if (!winner) continue;

    for (const loser of round.candidates) {
      if (loser.id === winner.id) continue;
      pairs.push({
        roundId: round.id,
        voteId: vote.id,
        profileId: round.profileId,
        category: round.category ?? "manual",
        model: round.model ?? "unknown",
        trial: round.trial ?? "test",
        text: round.text,
        chosen: side(winner, vote),
        rejected: side(loser, vote),
        ratings: { chosen: vote.ratings[winner.id] ?? null, rejected: vote.ratings[loser.id] ?? null },
        notes: vote.notes,
        createdAt: vote.createdAt,
      });
    }
  }

  return pairs;
}

export const LABELS = "ABCDEFGH".split("");

export function isValidRating(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}
