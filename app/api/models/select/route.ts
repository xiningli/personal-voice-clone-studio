import { NextRequest } from "next/server";
import { selectModel, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

/** Body: {id}. Hot-swaps the backend model; new arena rounds record the new id. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    return Response.json(await selectModel(body.id));
  } catch (err) {
    return errorResponse(err);
  }
}
