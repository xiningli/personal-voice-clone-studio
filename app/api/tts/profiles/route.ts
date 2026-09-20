import { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import { getProfiles, saveProfile } from "@/lib/storage";
import { getTakes, DEFAULT_SPEAKER, rebuildProfilePrompt, takeBelongs } from "@/lib/corpus";
import { EMOTIONS } from "@/lib/reading-scripts";
import { ingestTake } from "@/lib/take-ingest";
import type { VoiceProfile, VoiceProfileSummary, Language } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Profiles with their corpus counters (accepted / rejected takes, accepted seconds). */
export async function GET() {
  const [profiles, takes] = await Promise.all([getProfiles(), getTakes(DEFAULT_SPEAKER)]);
  const out: VoiceProfileSummary[] = profiles.map((p) => {
    const mine = takes.filter((t) => takeBelongs(t, p));
    const accepted = mine.filter((t) => t.verdict === "accept");
    return {
      ...p,
      acceptedTakes: accepted.length,
      rejectedTakes: mine.length - accepted.length,
      acceptedSeconds: Math.round(accepted.reduce((s, t) => s + t.metrics.duration, 0) * 10) / 10,
    };
  });
  return Response.json(out);
}

function normLanguage(v: unknown): Language {
  return v === "zh" ? "zh" : "en";
}

function normEmotion(v: unknown): string {
  const id = typeof v === "string" ? v.trim() : "";
  return EMOTIONS.some((e) => e.id === id) ? id : "neutral";
}

/**
 * Create a profile. Two bodies are accepted:
 * - JSON `{name, language, emotion, description?}` → an empty profile; takes are recorded
 *   afterwards through the session (POST /api/corpus/takes with profileId).
 * - multipart `name, language, emotion, transcript, audio` ("Upload a clip"): the clip goes
 *   through the same QC as a recorded take. The profile is created either way; the response
 *   carries `take` with its verdict and reasons so the UI can show a rejection.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") || "";
  let name = "";
  let description = "";
  let language: Language = "en";
  let emotion = "neutral";
  let upload: { file: File; transcript: string } | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    name = ((form.get("name") as string | null) ?? "").trim();
    description = (form.get("description") as string | null) ?? "";
    language = normLanguage(form.get("language"));
    emotion = normEmotion(form.get("emotion"));
    const file = form.get("audio") as File | null;
    const transcript = ((form.get("transcript") as string | null) ?? "").trim();
    if (file) {
      if (!transcript) return Response.json({ error: "transcript is required with an uploaded clip" }, { status: 400 });
      upload = { file, transcript };
    }
  } else {
    const body = (await request.json().catch(() => ({}))) as Partial<{ name: string; language: string; emotion: string; description: string }>;
    name = (body.name ?? "").trim();
    description = body.description ?? "";
    language = normLanguage(body.language);
    emotion = normEmotion(body.emotion);
  }
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  // One profile per category: creating (emotion, language) again returns the existing
  // profile instead of splitting its takes across two ids.
  const existing = (await getProfiles()).find((p) => p.emotion === emotion && p.language === language);
  if (existing && !upload) {
    return Response.json({ ...existing, existing: true }, { status: 200 });
  }
  if (existing && upload) {
    const take = await ingestTake({
      file: upload.file, promptId: `upload-${Date.now()}`, text: upload.transcript, emotion, language,
      sessionId: "upload", profileId: existing.id,
    });
    Object.assign(existing, await rebuildProfilePrompt(existing), { updatedAt: new Date().toISOString() });
    await saveProfile(existing);
    return Response.json({ ...existing, existing: true, take }, { status: 200 });
  }

  const now = new Date().toISOString();
  const profile: VoiceProfile = {
    id: uuid(),
    name,
    description,
    referenceAudioPath: "",
    promptAudioPath: "",
    promptText: "",
    language,
    emotion,
    createdAt: now,
    updatedAt: now,
  };
  await saveProfile(profile);

  if (!upload) return Response.json(profile, { status: 201 });

  try {
    const take = await ingestTake({
      file: upload.file,
      promptId: `upload-${profile.id.slice(0, 8)}`,
      text: upload.transcript,
      emotion,
      language,
      sessionId: "upload",
      profileId: profile.id,
    });
    if (take.verdict === "accept") {
      Object.assign(profile, await rebuildProfilePrompt(profile), { updatedAt: new Date().toISOString() });
      await saveProfile(profile);
    }
    return Response.json({ ...profile, take }, { status: 201 });
  } catch (err) {
    return Response.json({ ...profile, error: err instanceof Error ? err.message : "QC failed" }, { status: 502 });
  }
}
