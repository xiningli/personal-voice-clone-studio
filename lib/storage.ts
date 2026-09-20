import fs from "fs/promises";
import path from "path";
import type { VoiceProfile, ArenaRound, ArenaVote, VoiceStylePreset } from "./types";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PROFILES_FILE = path.join(DATA_DIR, "voice-profiles.json");
const ARENA_ROUNDS_FILE = path.join(DATA_DIR, "arena-rounds.json");
const ARENA_VOTES_FILE = path.join(DATA_DIR, "arena-votes.jsonl");
const PRESETS_FILE = path.join(ROOT, "styles", "voice-presets.json");
const UPLOADS_DIR = path.join(ROOT, "public", "audio", "uploads");
const GENERATED_DIR = path.join(ROOT, "public", "audio", "generated");
const ARENA_DIR = path.join(ROOT, "public", "audio", "arena");

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.mkdir(ARENA_DIR, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await ensureDirs();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Map a public URL path like /audio/uploads/x.wav to its absolute path on disk. */
export function publicPathToAbs(publicPath: string): string {
  const clean = publicPath.replace(/^\/+/, "");
  const abs = path.resolve(ROOT, "public", clean);
  if (!abs.startsWith(path.join(ROOT, "public"))) {
    throw new Error("path escapes public/");
  }
  return abs;
}

// Voice Profiles
export async function getProfiles(): Promise<VoiceProfile[]> {
  await ensureDirs();
  const raw = await readJson<Partial<VoiceProfile>[]>(PROFILES_FILE, []);
  // Profiles created before the CosyVoice rewrite lack prompt fields; keep them
  // listed so they can be re-prepared, but never crash on them.
  return raw.map((p) => ({
    id: p.id ?? "",
    name: p.name ?? "",
    description: p.description ?? "",
    referenceAudioPath: p.referenceAudioPath ?? "",
    promptAudioPath: p.promptAudioPath ?? "",
    promptText: p.promptText ?? "",
    language: p.language ?? "auto",
    emotion: p.emotion ?? "neutral",
    durationSeconds: p.durationSeconds,
    createdAt: p.createdAt ?? new Date(0).toISOString(),
    updatedAt: p.updatedAt ?? new Date(0).toISOString(),
  }));
}

export async function getProfile(id: string): Promise<VoiceProfile | null> {
  const profiles = await getProfiles();
  return profiles.find((p) => p.id === id) ?? null;
}

export async function saveProfile(profile: VoiceProfile): Promise<void> {
  const profiles = await getProfiles();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  await writeJson(PROFILES_FILE, profiles);
}

export async function deleteProfile(id: string): Promise<boolean> {
  const profiles = await getProfiles();
  const filtered = profiles.filter((p) => p.id !== id);
  if (filtered.length === profiles.length) return false;
  await writeJson(PROFILES_FILE, filtered);
  return true;
}

// Style presets (read-only from styles/voice-presets.json)
export async function getPresets(): Promise<VoiceStylePreset[]> {
  const data = await readJson<{ presets: VoiceStylePreset[] }>(PRESETS_FILE, { presets: [] });
  return data.presets;
}

// Arena rounds (json array) and votes (append-only jsonl)
export async function getArenaRounds(): Promise<ArenaRound[]> {
  await ensureDirs();
  return readJson<ArenaRound[]>(ARENA_ROUNDS_FILE, []);
}

export async function getArenaRound(id: string): Promise<ArenaRound | null> {
  const rounds = await getArenaRounds();
  return rounds.find((r) => r.id === id) ?? null;
}

export async function saveArenaRound(round: ArenaRound): Promise<void> {
  const rounds = await getArenaRounds();
  const idx = rounds.findIndex((r) => r.id === round.id);
  if (idx >= 0) rounds[idx] = round;
  else rounds.push(round);
  await writeJson(ARENA_ROUNDS_FILE, rounds);
}

export async function getArenaVotes(): Promise<ArenaVote[]> {
  await ensureDirs();
  try {
    const text = await fs.readFile(ARENA_VOTES_FILE, "utf-8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ArenaVote);
  } catch {
    return [];
  }
}

export async function appendArenaVote(vote: ArenaVote): Promise<void> {
  await ensureDirs();
  await fs.appendFile(ARENA_VOTES_FILE, JSON.stringify(vote) + "\n", "utf-8");
}

// File operations
export function getUploadsDir(): string {
  return UPLOADS_DIR;
}

export function getGeneratedDir(): string {
  return GENERATED_DIR;
}

export function getArenaDir(): string {
  return ARENA_DIR;
}

export async function saveUploadedFile(buffer: Buffer, filename: string): Promise<string> {
  await ensureDirs();
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, buffer);
  return `/audio/uploads/${filename}`;
}

export async function saveGeneratedFile(buffer: Buffer, filename: string): Promise<string> {
  await ensureDirs();
  await fs.writeFile(path.join(GENERATED_DIR, filename), buffer);
  return `/audio/generated/${filename}`;
}

export async function saveArenaFile(buffer: Buffer, filename: string): Promise<string> {
  await ensureDirs();
  await fs.writeFile(path.join(ARENA_DIR, filename), buffer);
  return `/audio/arena/${filename}`;
}
