import { cancelJob, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await cancelJob(id));
  } catch (err) {
    return errorResponse(err);
  }
}
