import { NextRequest } from "next/server";
import path from "path";
import { startSFT, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

/** Body: {name, speakerId?, epochs?, lr?, heldoutFraction?, seed?, trainFlow?, baseModel?} */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const speaker = String(body.speakerId ?? "owner").replace(/[^A-Za-z0-9_-]/g, "");
  try {
    const job = await startSFT({
      name,
      speaker_id: speaker,
      dataset_dir: path.join(process.cwd(), "datasets", speaker),
      base_model: typeof body.baseModel === "string" && body.baseModel ? body.baseModel : undefined,
      epochs: typeof body.epochs === "number" ? body.epochs : undefined,
      lr: typeof body.lr === "number" ? body.lr : undefined,
      heldout_fraction: typeof body.heldoutFraction === "number" ? body.heldoutFraction : undefined,
      seed: typeof body.seed === "number" ? body.seed : undefined,
      train_flow: body.trainFlow === true,
      include_borderline: body.includeBorderline === true,
    });
    return Response.json(job, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
