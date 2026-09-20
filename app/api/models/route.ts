import { listModels, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await listModels());
  } catch (err) {
    return errorResponse(err);
  }
}
