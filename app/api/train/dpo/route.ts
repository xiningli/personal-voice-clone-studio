import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getArenaRounds, getArenaVotes } from "@/lib/storage";
import { buildPreferencePairs } from "@/lib/arena";
import { startDPO, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

/**
 * Body: {name, baseModel (stage-A checkpoint dir or model id), refModel?, beta?, epochs?, lr?, force?}
 * Writes the current decided pairs for that base model to models/<name>/pairs.jsonl and hands the
 * file to the backend. Only pairs whose two sides share the same instruction qualify: DPO compares
 * two samples of the same prompt, so rounds that varied the instruction (instruction preference)
 * are excluded; rounds that varied only the seed (same instruct) are the DPO data.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const baseModel = String(body.baseModel ?? "").trim();
  if (!name || !baseModel) return Response.json({ error: "name and baseModel are required" }, { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return Response.json({ error: "invalid name" }, { status: 400 });
  }
  const [rounds, votes] = await Promise.all([getArenaRounds(), getArenaVotes()]);
  const baseName = path.basename(baseModel);
  const pairs = buildPreferencePairs(rounds, votes).filter(
    (p) =>
      (p.trial === "test" || p.trial === "seed") &&
      p.chosen.instruct.trim() === p.rejected.instruct.trim() &&
      (p.model === baseModel || path.basename(p.model) === baseName)
  );
  const dir = path.join(process.cwd(), "models", name);
  await fs.mkdir(dir, { recursive: true });
  const pairsFile = path.join(dir, "pairs.jsonl");
  await fs.writeFile(pairsFile, pairs.map((p) => JSON.stringify(p)).join("\n") + (pairs.length ? "\n" : ""));
  try {
    const job = await startDPO({
      name,
      pairs_file: pairsFile,
      base_model: baseModel,
      ref_model: typeof body.refModel === "string" && body.refModel ? body.refModel : undefined,
      beta: typeof body.beta === "number" ? body.beta : undefined,
      epochs: typeof body.epochs === "number" ? body.epochs : undefined,
      lr: typeof body.lr === "number" ? body.lr : undefined,
      force: body.force === true,
    });
    return Response.json({ ...job, pairs: pairs.length }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
