import { getJob, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await getJob(id));
  } catch (err) {
    return errorResponse(err);
  }
}
