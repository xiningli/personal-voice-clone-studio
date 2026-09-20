import { NextRequest } from "next/server";
import { getArenaRounds, getArenaVotes } from "@/lib/storage";
import { buildPreferencePairs } from "@/lib/arena";

export const dynamic = "force-dynamic";

/** DPO-style chosen/rejected pairs. Default is JSONL for download; ?format=json returns an array. */
export async function GET(request: NextRequest) {
  const [rounds, votes] = await Promise.all([getArenaRounds(), getArenaVotes()]);
  const pairs = buildPreferencePairs(rounds, votes);

  if (request.nextUrl.searchParams.get("format") === "json") {
    return Response.json(pairs);
  }
  const body = pairs.map((p) => JSON.stringify(p)).join("\n") + (pairs.length ? "\n" : "");
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="preference-pairs.jsonl"',
    },
  });
}
