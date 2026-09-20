import { NextRequest } from "next/server";
import { takeBelongs } from "@/lib/corpus";
import { getTakes, DEFAULT_SPEAKER, rebuildProfilePrompt } from "@/lib/corpus";
import { ingestTake } from "@/lib/take-ingest";
import { getProfile, saveProfile } from "@/lib/storage";
import type { Language } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const speaker = q.get("speaker") || DEFAULT_SPEAKER;
  const emotion = q.get("emotion");
  const verdict = q.get("verdict");
  const profileId = q.get("profileId");
  try {
    let takes = await getTakes(speaker);
    if (emotion) takes = takes.filter((t) => t.emotion === emotion);
    if (verdict) takes = takes.filter((t) => t.verdict === verdict);
    if (profileId) {
      const profile = await getProfile(profileId);
      takes = profile ? takes.filter((t) => takeBelongs(t, profile)) : takes.filter((t) => t.profileId === profileId);
    }
    takes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json(takes);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}

/**
 * multipart: audio, promptId, text, profileId (the session's profile; its emotion and
 * language are used), sessionId?, speaker?. Without profileId, emotion/language may be
 * given directly (legacy corpus takes). An accepted take rebuilds the profile's prompt.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const audio = form.get("audio") as File | null;
  const promptId = (form.get("promptId") as string | null)?.trim();
  const text = (form.get("text") as string | null)?.trim();
  const profileId = (form.get("profileId") as string | null)?.trim() || undefined;
  const sessionId = (form.get("sessionId") as string | null)?.trim() || "session";
  const speakerId = (form.get("speaker") as string | null)?.trim() || DEFAULT_SPEAKER;
  let emotion = (form.get("emotion") as string | null)?.trim() || "neutral";
  let language = ((form.get("language") as string | null) || "en") as Language;
  if (!audio || !promptId || !text) {
    return Response.json({ error: "audio, promptId and text are required" }, { status: 400 });
  }
  const profile = profileId ? await getProfile(profileId) : null;
  if (profileId && !profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  if (profile) {
    emotion = profile.emotion;
    language = profile.language;
  }

  let take;
  try {
    take = await ingestTake({ file: audio, promptId, text, emotion, language, sessionId, profileId, speakerId });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "QC failed" }, { status: 502 });
  }

  if (profile && take.verdict === "accept") {
    Object.assign(profile, await rebuildProfilePrompt(profile, speakerId), { updatedAt: new Date().toISOString() });
    await saveProfile(profile);
  }
  return Response.json(take, { status: 201 });
}
