import { getArenaRound } from "@/lib/storage";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const round = await getArenaRound(id);
  if (!round) {
    return Response.json({ error: "Round not found" }, { status: 404 });
  }
  return Response.json(round);
}
