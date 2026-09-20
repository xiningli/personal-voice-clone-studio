import { getArenaRounds, getArenaVotes, getProfiles } from "@/lib/storage";
import { computeInstructStats } from "@/lib/arena";

export const dynamic = "force-dynamic";

/**
 * Hand-off for a downstream digital human. Its backend's POST /voice accepts an
 * optional `instruct` string next to `text`; the winning instructs below are what to
 * put there per voice profile, ranked by the owner's own Arena votes.
 */
export async function GET() {
  const [profiles, rounds, votes] = await Promise.all([getProfiles(), getArenaRounds(), getArenaVotes()]);

  const result = profiles.map((profile) => {
    const own = rounds.filter((r) => r.profileId === profile.id);
    const ownIds = new Set(own.map((r) => r.id));
    const ownVotes = votes.filter((v) => ownIds.has(v.roundId));
    const topInstructs = computeInstructStats(own, ownVotes)
      .filter((s) => s.rounds >= 1)
      .sort((a, b) => b.elo - a.elo)
      .slice(0, 5)
      .map((s) => ({
        instruct: s.instruct,
        elo: s.elo,
        winRate: s.winRate,
        rounds: s.rounds,
        avgEmotion: s.avgEmotion,
        avgSimilarity: s.avgSimilarity,
      }));
    return {
      profileId: profile.id,
      name: profile.name,
      promptAudioPath: profile.promptAudioPath,
      promptText: profile.promptText,
      language: profile.language,
      topInstructs,
    };
  });

  return Response.json({ generatedAt: new Date().toISOString(), profiles: result });
}
