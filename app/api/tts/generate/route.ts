import { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import { getProfile, publicPathToAbs, saveGeneratedFile } from "@/lib/storage";
import { generateSpeech, chunkText, stripMarkdown } from "@/lib/tts-client";
import type { TTSRequest, GeneratedAudio } from "@/lib/types";

export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    text,
    voiceProfileId,
    speed = 1.0,
    instruct = "",
    seed,
    mode = "auto",
  } = body as TTSRequest & { stylePresetId?: string };

  if (!text || !voiceProfileId) {
    return Response.json({ error: "Text and voiceProfileId are required" }, { status: 400 });
  }

  const profile = await getProfile(voiceProfileId);
  if (!profile) {
    return Response.json({ error: "Voice profile not found" }, { status: 404 });
  }
  if (!profile.promptAudioPath) {
    return Response.json(
      { error: "This profile has no prepared prompt audio. Re-create it on the Voice Profiles page." },
      { status: 409 }
    );
  }

  const plainText = stripMarkdown(text);
  const chunks = chunkText(plainText);
  const results: GeneratedAudio[] = [];

  try {
    for (const chunk of chunks) {
      const id = uuid();
      const filename = `tts-${id}.wav`;
      const out = await generateSpeech({
        text: chunk,
        promptAudioAbsPath: publicPathToAbs(profile.promptAudioPath),
        promptText: profile.promptText,
        instruct,
        speed,
        seed,
        mode,
      });
      const publicPath = await saveGeneratedFile(out.audioBuffer, filename);
      results.push({
        id,
        filename,
        path: publicPath,
        duration: out.duration,
        format: "wav",
        voiceProfileId,
        stylePresetId: body.stylePresetId,
        instruct,
        speed,
        seed: out.seed,
        mode: out.mode,
        elapsedSeconds: out.elapsedSeconds,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Generation failed", audioFiles: results },
      { status: 502 }
    );
  }

  return Response.json({ audioFiles: results });
}
