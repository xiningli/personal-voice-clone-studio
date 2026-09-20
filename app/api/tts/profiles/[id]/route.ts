import { NextRequest } from "next/server";
import fs from "fs/promises";
import { getProfile, deleteProfile, saveProfile, publicPathToAbs } from "@/lib/storage";
import { deleteProfileTakes, profileTakes, rebuildProfilePrompt } from "@/lib/corpus";
import { EMOTIONS } from "@/lib/reading-scripts";
import type { Language } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getProfile(id);
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  const takes = await profileTakes(profile);
  return Response.json({ ...profile, takes });
}

/** Edit name, description, language or emotion. The prompt and its transcript are derived from accepted takes. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getProfile(id);
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  const body = (await request.json()) as Partial<{ name: string; description: string; language: Language; emotion: string }>;
  if (typeof body.name === "string" && body.name.trim()) profile.name = body.name.trim();
  if (typeof body.description === "string") profile.description = body.description;
  if (body.language === "zh" || body.language === "en") profile.language = body.language;
  if (typeof body.emotion === "string" && EMOTIONS.some((e) => e.id === body.emotion)) profile.emotion = body.emotion;
  profile.updatedAt = new Date().toISOString();
  await saveProfile(profile);
  return Response.json(profile);
}

/** Recompute the derived prompt (after takes changed elsewhere). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getProfile(id);
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  Object.assign(profile, await rebuildProfilePrompt(profile), { updatedAt: new Date().toISOString() });
  await saveProfile(profile);
  return Response.json(profile);
}

/** Delete the profile, every take of its category (files included) and its derived prompt. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getProfile(id);
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  const removedTakes = await deleteProfileTakes(profile);
  for (const p of [profile.referenceAudioPath, profile.promptAudioPath]) {
    if (!p) continue;
    await fs.unlink(publicPathToAbs(p)).catch(() => undefined);
  }
  await deleteProfile(id);
  return Response.json({ success: true, removedTakes });
}
