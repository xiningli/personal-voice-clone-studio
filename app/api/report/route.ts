import { NextRequest } from "next/server";
import { getArenaRounds, getArenaVotes } from "@/lib/storage";
import { evaluationSection } from "@/lib/report";

export const dynamic = "force-dynamic";

/**
 * GET /api/report — the current state as Markdown (docs/protocol.md §4).
 * The corpus (§1) and training (§3) sections are contributed by their own modules; until they
 * export a builder, their placeholders below stay in the output so the structure is stable.
 */
export async function GET(request: NextRequest) {
  const [rounds, votes] = await Promise.all([getArenaRounds(), getArenaVotes()]);
  const raw = request.nextUrl.searchParams.get("bootstrap");
  const bootstrapParam = raw === null || raw === "" ? NaN : Number(raw);
  const bootstrap = Number.isFinite(bootstrapParam) && bootstrapParam >= 0 ? Math.min(5000, bootstrapParam) : 1000;

  const parts = [
    `# Personal Voice Clone Studio — evaluation report\n`,
    `Generated ${new Date().toISOString()}\n`,
    `<!-- corpus -->\n`,
    evaluationSection(rounds, votes, bootstrap),
    `<!-- training -->\n`,
  ];
  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
