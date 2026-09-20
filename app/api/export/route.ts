import { NextRequest } from "next/server";
import { listBundles, listExportJobs, startExport } from "@/lib/export-client";

export const dynamic = "force-dynamic";

/** GET: bundles under exports/ and export jobs. POST: start an export (see lib/api-docs.ts). */
export async function GET() {
  try {
    const [bundles, jobs] = await Promise.all([listBundles(), listExportJobs()]);
    return Response.json({ bundles, jobs });
  } catch (err) { return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 }); }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { modelId?: string; name?: string; profileIds?: string[]; push?: { host?: string; path?: string } };
  if (!body.modelId) return Response.json({ error: "modelId is required" }, { status: 400 });
  try {
    const job = await startExport({
      model_id: body.modelId, name: body.name || undefined, profile_ids: body.profileIds?.length ? body.profileIds : undefined,
      push: body.push?.host ? { host: body.push.host, path: body.push.path || undefined } : undefined,
    });
    return Response.json(job, { status: 201 });
  } catch (err) { return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 }); }
}
