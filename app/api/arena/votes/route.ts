import { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import { appendArenaVote, getArenaRound, getArenaVotes } from "@/lib/storage";
import { isValidRating } from "@/lib/arena";
import type { ArenaVote, CandidateRating } from "@/lib/types";

export async function GET() {
  return Response.json(await getArenaVotes());
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { roundId, winnerId = null, ratings = {}, notes = "", candidateNotes = {} } = body as {
    roundId?: string;
    winnerId?: string | null;
    ratings?: Record<string, Partial<CandidateRating>>;
    notes?: string;
    candidateNotes?: Record<string, string>;
  };

  if (!roundId) {
    return Response.json({ error: "roundId is required" }, { status: 400 });
  }
  const round = await getArenaRound(roundId);
  if (!round) {
    return Response.json({ error: "Round not found" }, { status: 404 });
  }
  const candidateIds = new Set(round.candidates.map((c) => c.id));
  if (winnerId !== null && !candidateIds.has(winnerId)) {
    return Response.json({ error: "winnerId is not a candidate of this round" }, { status: 400 });
  }

  const cleanRatings: Record<string, CandidateRating> = {};
  for (const [candidateId, r] of Object.entries(ratings ?? {})) {
    if (!candidateIds.has(candidateId)) {
      return Response.json({ error: `Unknown candidate in ratings: ${candidateId}` }, { status: 400 });
    }
    if (!r || !isValidRating(r.naturalness) || !isValidRating(r.emotion) || !isValidRating(r.similarity)) {
      return Response.json({ error: "Each rating needs naturalness, emotion and similarity as integers 1-5" }, { status: 400 });
    }
    cleanRatings[candidateId] = { naturalness: r.naturalness, emotion: r.emotion, similarity: r.similarity };
  }

  const cleanNotes: Record<string, string> = {};
  for (const [candidateId, note] of Object.entries(candidateNotes ?? {})) {
    if (!candidateIds.has(candidateId)) {
      return Response.json({ error: `Unknown candidate in candidateNotes: ${candidateId}` }, { status: 400 });
    }
    if (typeof note === "string" && note.trim()) cleanNotes[candidateId] = note.trim();
  }

  const vote: ArenaVote = {
    id: uuid(),
    roundId,
    createdAt: new Date().toISOString(),
    winnerId,
    ratings: cleanRatings,
    notes: typeof notes === "string" ? notes.trim() : "",
    candidateNotes: cleanNotes,
  };
  await appendArenaVote(vote);
  return Response.json(vote, { status: 201 });
}
