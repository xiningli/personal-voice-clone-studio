import { NextRequest } from "next/server";
import { corpusStats, DEFAULT_SPEAKER } from "@/lib/corpus";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const speaker = request.nextUrl.searchParams.get("speaker") || DEFAULT_SPEAKER;
  try {
    return Response.json(await corpusStats(speaker));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}
