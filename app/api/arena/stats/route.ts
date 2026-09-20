import { NextRequest } from "next/server";
import { getArenaRounds, getArenaVotes } from "@/lib/storage";
import { computeInstructStats } from "@/lib/arena";
import { fitBradleyTerry, raterReliability, modelDuels } from "@/lib/arena-stats";

export const dynamic = "force-dynamic";

/**
 * Per-instruct statistics. Rounds from different backend models are never mixed:
 * ?model=<id> selects one (default: the model of the most recent round); ?model=all pools them.
 */
export async function GET(request: NextRequest) {
  const [allRounds, allVotes] = await Promise.all([getArenaRounds(), getArenaVotes()]);
  // "duel" is a pseudo-model: those rounds are reported in `duels`, never as a partition.
  const models = [...new Set(allRounds.map((r) => r.model ?? "unknown"))].filter((m) => m !== "duel");
  const newest = [...allRounds].filter((r) => r.model !== "duel").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const requested = request.nextUrl.searchParams.get("model");
  const model = requested && requested !== "" ? requested : newest?.model ?? "all";

  const rounds = model === "all" ? allRounds : allRounds.filter((r) => (r.model ?? "unknown") === model);
  const roundIds = new Set(rounds.map((r) => r.id));
  const votes = allVotes.filter((v) => roundIds.has(v.roundId));
  const stats = computeInstructStats(rounds, votes).sort((a, b) => b.elo - a.elo);
  const rawBootstrap = request.nextUrl.searchParams.get("bootstrap");
  const bootstrapParam = rawBootstrap === null || rawBootstrap === "" ? NaN : Number(rawBootstrap);
  const bootstrap = Number.isFinite(bootstrapParam) && bootstrapParam >= 0 ? Math.min(5000, bootstrapParam) : 1000;
  // Bradley-Terry over decided test trials only; repeat/anchor trials feed reliability instead.
  const bt = fitBradleyTerry(allRounds, allVotes, { model, bootstrap });
  const reliability = raterReliability(allRounds, allVotes, model);
  const trials = { test: 0, repeat: 0, anchor: 0, duel: 0 } as Record<string, number>;
  for (const r of rounds) trials[r.trial ?? "test"] = (trials[r.trial ?? "test"] ?? 0) + 1;
  // Duels compare checkpoints, so they are reported over all rounds, independent of the partition.
  const duels = modelDuels(allRounds, allVotes);
  return Response.json({ model, models, totalRounds: rounds.length, totalVotes: votes.length, trials, stats, bt, reliability, duels, bootstrap });
}
