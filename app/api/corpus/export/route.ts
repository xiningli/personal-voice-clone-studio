import { NextRequest } from "next/server";
import { exportCorpus, DEFAULT_SPEAKER } from "@/lib/corpus";

export const dynamic = "force-dynamic";

/** Write datasets/<speaker>/export/{metadata.csv, emotions.csv, wavs/, DATASET_CARD.md}. */
export async function GET(request: NextRequest) {
  const speaker = request.nextUrl.searchParams.get("speaker") || DEFAULT_SPEAKER;
  try {
    return Response.json(await exportCorpus(speaker));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "export failed" }, { status: 400 });
  }
}
