import { listJobs, errorResponse } from "@/lib/train-client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await listJobs());
  } catch (err) {
    return errorResponse(err);
  }
}
