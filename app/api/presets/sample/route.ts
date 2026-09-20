import { NextRequest } from "next/server";
import { getPresets } from "@/lib/storage";
import { sampleForPreset } from "@/lib/preset-sample";

export const dynamic = "force-dynamic";

/** ?presetId= → a random sentence whose content fits that preset (any category when omitted). */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("presetId") || "";
  const preset = id ? (await getPresets()).find((p) => p.id === id) ?? null : null;
  return Response.json(await sampleForPreset(preset));
}
