import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { deleteTake, getTakes, DEFAULT_SPEAKER, rebuildProfilePrompt } from "@/lib/corpus";
import { getProfile, saveProfile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Stream the take's wav so the page can play it (datasets/ is not under public/). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const speaker = request.nextUrl.searchParams.get("speaker") || DEFAULT_SPEAKER;
  const take = (await getTakes(speaker)).find((t) => t.id === id);
  if (!take) return Response.json({ error: "Take not found" }, { status: 404 });
  try {
    const data = await fs.readFile(path.resolve(process.cwd(), take.audioPath));
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Audio missing on disk" }, { status: 404 });
  }
}

/** Delete a take; if it belonged to a profile, that profile's prompt is rebuilt from what is left. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const speaker = request.nextUrl.searchParams.get("speaker") || DEFAULT_SPEAKER;
  const take = (await getTakes(speaker)).find((t) => t.id === id);
  if (!take) return Response.json({ error: "Take not found" }, { status: 404 });
  await deleteTake(speaker, id);
  if (take.profileId) {
    const profile = await getProfile(take.profileId);
    if (profile) {
      Object.assign(profile, await rebuildProfilePrompt(profile, speaker), { updatedAt: new Date().toISOString() });
      await saveProfile(profile);
    }
  }
  return Response.json({ success: true });
}
