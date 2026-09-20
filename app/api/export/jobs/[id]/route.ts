import { getExportJob } from "@/lib/export-client";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return Response.json(await getExportJob((await params).id)); }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 }); }
}
