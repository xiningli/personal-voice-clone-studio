import fs from "fs/promises";
import path from "path";
import type { Take, CorpusStats, VoiceProfile } from "./types";
import { scriptsFor } from "./reading-scripts";

const ROOT = process.cwd();
const UPLOADS_DIR = path.join(ROOT, "public", "audio", "uploads");
export const DATASETS_DIR = path.join(ROOT, "datasets");
const PROMPTS_DIR = path.join(ROOT, "content", "prompts");

export const DEFAULT_SPEAKER = "owner";

export const CORPUS_THRESHOLDS = {
  zeroShotProfileSec: 60,
  sftSec: 600,
  sftRecommendedSec: 1800,
  emotionSftSec: 300,
  dpoPairs: 200,
};

export interface Prompt {
  id: string;
  text: string;
  /** Expected spoken length at a natural reading pace (see estimateSeconds). */
  estSeconds?: number;
}

/** Reading-time model: ~150 wpm plus a fixed breath/onset cost per sentence. */
export const SEC_PER_WORD = 0.38;
export const SEC_PER_SENTENCE = 0.6;
export function estimateSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((SEC_PER_WORD * words + SEC_PER_SENTENCE) * 10) / 10;
}

/** Planning assumption when a profile has no history yet (observed on this machine). */
export const DEFAULT_ACCEPT_RATE = 0.6;

export interface BankStatus {
  bank: string; // "arctic" | emotion id
  total: number;
  remaining: number; // not yet accepted for this profile's emotion
  remainingEstSeconds: number; // speech the remaining sentences would yield if all accepted
  targetSeconds: number; // 600 for neutral (SFT minimum), 300 for an emotion
  acceptedSeconds: number; // this emotion, all profiles
  acceptRate: number; // this profile's own accept rate, or the default
  avgTakeSeconds: number; // this profile's mean accepted take length, or the bank's estimate
  sentencesNeeded: number; // ≈ accepted takes still needed to reach the target
  takesNeeded: number; // ≈ recordings needed at the current accept rate
  enough: boolean; // the bank can still reach the target at that rate
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function assertSafeId(id: string, what = "id"): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${what}`);
  return id;
}

/** Resolve a path inside datasets/ and refuse anything that escapes it. */
export function datasetPath(...parts: string[]): string {
  const abs = path.resolve(DATASETS_DIR, ...parts);
  if (!abs.startsWith(DATASETS_DIR + path.sep) && abs !== DATASETS_DIR) {
    throw new Error("path escapes datasets/");
  }
  return abs;
}

export function speakerDir(speakerId = DEFAULT_SPEAKER): string {
  return datasetPath(assertSafeId(speakerId, "speaker id"));
}

async function ensureSpeakerDirs(speakerId: string) {
  const dir = speakerDir(speakerId);
  await fs.mkdir(path.join(dir, "wavs"), { recursive: true });
  await fs.mkdir(path.join(dir, "raw"), { recursive: true });
}

function takesFile(speakerId: string): string {
  return path.join(speakerDir(speakerId), "takes.jsonl");
}

export async function getTakes(speakerId = DEFAULT_SPEAKER): Promise<Take[]> {
  try {
    const text = await fs.readFile(takesFile(speakerId), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Take);
  } catch {
    return [];
  }
}

export async function appendTake(take: Take): Promise<void> {
  await ensureSpeakerDirs(take.speakerId);
  await fs.appendFile(takesFile(take.speakerId), JSON.stringify(take) + "\n", "utf-8");
}

/** Replace one take record in place (same id). Returns false when the id is unknown. */
export async function updateTake(take: Take): Promise<boolean> {
  const takes = await getTakes(take.speakerId);
  const idx = takes.findIndex((t) => t.id === take.id);
  if (idx < 0) return false;
  takes[idx] = take;
  await fs.writeFile(takesFile(take.speakerId), takes.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf-8");
  return true;
}

export async function deleteTake(speakerId: string, takeId: string): Promise<boolean> {
  const takes = await getTakes(speakerId);
  const victim = takes.find((t) => t.id === takeId);
  if (!victim) return false;
  const rest = takes.filter((t) => t.id !== takeId);
  await fs.writeFile(takesFile(speakerId), rest.map((t) => JSON.stringify(t)).join("\n") + (rest.length ? "\n" : ""), "utf-8");
  for (const p of [victim.audioPath, victim.sourcePath]) {
    if (!p) continue;
    try {
      await fs.unlink(datasetPath(path.relative(DATASETS_DIR, path.resolve(ROOT, p))));
    } catch {
      /* already gone */
    }
  }
  return true;
}

export async function saveRaw(speakerId: string, takeId: string, ext: string, buffer: Buffer): Promise<string> {
  await ensureSpeakerDirs(speakerId);
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const abs = path.join(speakerDir(speakerId), "raw", `${assertSafeId(takeId)}.${safeExt}`);
  await fs.writeFile(abs, buffer);
  return abs;
}

export function wavPath(speakerId: string, takeId: string): string {
  return path.join(speakerDir(speakerId), "wavs", `${assertSafeId(takeId)}.wav`);
}

/** Store paths relative to the repo root so the dataset can move with the checkout. */
export function toRepoRelative(abs: string): string {
  return path.relative(ROOT, abs);
}

// ---- prompts ----

/**
 * "arctic" = CMU ARCTIC (phonetically balanced, the neutral corpus). Any other set name is
 * an emotion id whose bank lives in content/prompts/emotions/<emotion>.txt, one sentence
 * per line, ids <emotion>-0001…; a missing bank yields an empty list rather than an error.
 */
export async function loadPrompts(set = "arctic"): Promise<Prompt[]> {
  if (set === "arctic") {
    const text = await fs.readFile(path.join(PROMPTS_DIR, "cmuarctic.data"), "utf-8");
    const prompts: Prompt[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\(\s*(\S+)\s+"(.*)"\s*\)\s*$/);
      if (m) {
        const t = m[2].replace(/\\"/g, '"');
        prompts.push({ id: m[1], text: t, estSeconds: estimateSeconds(t) });
      }
    }
    return prompts;
  }
  assertSafeId(set, "prompt set");
  try {
    const text = await fs.readFile(path.join(PROMPTS_DIR, "emotions", `${set}.txt`), "utf-8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((t, i) => ({ id: `${set}-${String(i + 1).padStart(4, "0")}`, text: t, estSeconds: estimateSeconds(t) }));
  } catch {
    return [];
  }
}

/** Which bank an emotion reads from: neutral → ARCTIC, everything else → its own bank. */
export function bankFor(emotion: string): string {
  return emotion === "neutral" ? "arctic" : emotion;
}

export function targetSecondsFor(emotion: string): number {
  return emotion === "neutral" ? CORPUS_THRESHOLDS.sftSec : CORPUS_THRESHOLDS.emotionSftSec;
}

/** How far this profile is from its target and whether its bank can get it there. */
export async function promptBankStatus(profile: VoiceProfile, speakerId = DEFAULT_SPEAKER): Promise<BankStatus> {
  const bank = bankFor(profile.emotion);
  const [prompts, takes] = await Promise.all([loadPrompts(bank), getTakes(speakerId)]);
  const emotionTakes = takes.filter((t) => t.emotion === profile.emotion);
  const acceptedEmotion = emotionTakes.filter((t) => t.verdict === "accept");
  const mine = takes.filter((t) => takeBelongs(t, profile));
  const mineAccepted = mine.filter((t) => t.verdict === "accept");
  const done = new Set(acceptedEmotion.map((t) => t.promptId));
  const remaining = prompts.filter((p) => !done.has(p.id));
  const remainingEst = remaining.reduce((s, p) => s + (p.estSeconds ?? estimateSeconds(p.text)), 0);
  const acceptedSeconds = acceptedEmotion.reduce((s, t) => s + t.metrics.duration, 0);
  const targetSeconds = targetSecondsFor(profile.emotion);
  const acceptRate = mine.length >= 5 ? Math.max(0.1, mineAccepted.length / mine.length) : DEFAULT_ACCEPT_RATE;
  const bankAvg = remaining.length ? remainingEst / remaining.length : SEC_PER_WORD * 10 + SEC_PER_SENTENCE;
  const avgTakeSeconds = mineAccepted.length >= 3 ? mineAccepted.reduce((s, t) => s + t.metrics.duration, 0) / mineAccepted.length : bankAvg;
  const missing = Math.max(0, targetSeconds - acceptedSeconds);
  const sentencesNeeded = Math.ceil(missing / Math.max(0.5, avgTakeSeconds));
  const takesNeeded = Math.ceil(sentencesNeeded / acceptRate);
  return {
    bank,
    total: prompts.length,
    remaining: remaining.length,
    remainingEstSeconds: Math.round(remainingEst),
    targetSeconds,
    acceptedSeconds: Math.round(acceptedSeconds * 10) / 10,
    acceptRate: Math.round(acceptRate * 100) / 100,
    avgTakeSeconds: Math.round(avgTakeSeconds * 10) / 10,
    sentencesNeeded,
    takesNeeded,
    enough: remaining.length >= sentencesNeeded,
  };
}

/** First n ARCTIC prompts not yet accepted for this emotion, in ARCTIC order. */
export async function nextPrompts(speakerId = DEFAULT_SPEAKER, n = 10, emotion = "neutral"): Promise<Prompt[]> {
  const [prompts, takes] = await Promise.all([loadPrompts(), getTakes(speakerId)]);
  const done = new Set(takes.filter((t) => t.verdict === "accept" && t.emotion === emotion).map((t) => t.promptId));
  return prompts.filter((p) => !done.has(p.id)).slice(0, Math.max(1, n));
}

/**
 * Prompt queue for a profile session: the emotion reading script(s) for the profile's
 * language first (their text is the QC transcript, so they double as the prompt source),
 * then the next sentences from the emotion's own bank (ARCTIC for neutral) not yet accepted
 * for that emotion. Chinese profiles get only the Chinese scripts (the banks are English).
 */
export async function profilePrompts(profile: VoiceProfile, n = 10, speakerId = DEFAULT_SPEAKER): Promise<Prompt[]> {
  const takes = await getTakes(speakerId);
  const done = new Set(takes.filter((t) => t.verdict === "accept" && takeBelongs(t, profile)).map((t) => t.promptId));
  const language = profile.language === "zh" ? "zh" : "en";
  const scripts = scriptsFor(language, profile.emotion)
    .filter((sc) => sc.emotion === profile.emotion && !done.has(sc.id))
    .map((sc) => ({ id: sc.id, text: sc.text, estSeconds: estimateSeconds(sc.text) }));
  if (language === "zh") return scripts.slice(0, Math.max(1, n));
  const doneEmotion = new Set(takes.filter((t) => t.verdict === "accept" && t.emotion === profile.emotion).map((t) => t.promptId));
  // Neutral reads the phonetically balanced ARCTIC set; every other emotion reads its own
  // bank, so the words a rater hears match the tag on the take.
  const bank = (await loadPrompts(bankFor(profile.emotion))).filter((p) => !doneEmotion.has(p.id));
  return [...scripts, ...bank].slice(0, Math.max(1, n));
}

// ---- profile-scoped takes and the derived prompt ----

/**
 * A profile is one category: (emotion, language). Every take of that category belongs to
 * it, whichever profile id the take was recorded under, so takes never split across
 * duplicate profiles and a re-created profile picks up earlier recordings.
 */
export function takeBelongs(t: Take, profile: Pick<VoiceProfile, "id" | "emotion" | "language">): boolean {
  return t.profileId === profile.id || (t.emotion === profile.emotion && t.language === profile.language);
}

export async function profileTakes(profile: Pick<VoiceProfile, "id" | "emotion" | "language">, speakerId = DEFAULT_SPEAKER): Promise<Take[]> {
  return (await getTakes(speakerId)).filter((t) => takeBelongs(t, profile));
}

export async function deleteProfileTakes(profile: Pick<VoiceProfile, "id" | "emotion" | "language">, speakerId = DEFAULT_SPEAKER): Promise<number> {
  const mine = await profileTakes(profile, speakerId);
  for (const t of mine) await deleteTake(speakerId, t.id);
  return mine.length;
}

interface Pcm16 {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** Minimal RIFF/WAVE reader for the 16-bit PCM files QC writes (tolerates LIST/other chunks). */
function readWav(buf: Buffer): Pcm16 {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || bits !== 16) throw new Error(`unsupported wav format ${format}/${bits}-bit`);
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size % 2);
  }
  if (!data || !sampleRate) throw new Error("wav without fmt/data chunks");
  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { sampleRate, channels, samples };
}

function writeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

function toMono(p: Pcm16): Int16Array {
  if (p.channels === 1) return p.samples;
  const n = Math.floor(p.samples.length / p.channels);
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < p.channels; c++) acc += p.samples[i * p.channels + c];
    mono[i] = Math.round(acc / p.channels);
  }
  return mono;
}

/** Best first: driest room, then cleanest signal. */
function byQuality(a: Take, b: Take): number {
  // Clean takes first: the cloning prompt should never carry borderline room sound when a
  // clean take exists.
  const qa = a.quality === "borderline" ? 1 : 0;
  const qb = b.quality === "borderline" ? 1 : 0;
  if (qa !== qb) return qa - qb;
  const ra = a.metrics.reverbTailDb ?? 0;
  const rb = b.metrics.reverbTailDb ?? 0;
  if (ra !== rb) return ra - rb;
  return b.metrics.snrDb - a.metrics.snrDb;
}

export const PROMPT_SINGLE_MIN_SEC = 5;
export const PROMPT_SINGLE_MAX_SEC = 15;
export const PROMPT_CONCAT_TARGET_SEC = 8;
const PROMPT_GAP_SEC = 0.25;

/**
 * Derive the profile's cloning prompt from its accepted takes and write it under
 * public/audio/uploads/profile-<id>-prompt.wav. Returns the updated fields (empty when the
 * profile has no accepted take). The prompt is the single best 5–15 s take when one exists,
 * otherwise the best takes concatenated with 250 ms of silence until ≥ 8 s.
 */
export async function rebuildProfilePrompt(
  profile: VoiceProfile,
  speakerId = DEFAULT_SPEAKER
): Promise<Pick<VoiceProfile, "promptAudioPath" | "promptText" | "durationSeconds">> {
  const accepted = (await profileTakes(profile, speakerId)).filter((t) => t.verdict === "accept").sort(byQuality);
  const outAbs = path.join(UPLOADS_DIR, `profile-${profile.id}-prompt.wav`);
  if (accepted.length === 0) {
    await fs.unlink(outAbs).catch(() => undefined);
    return { promptAudioPath: "", promptText: "", durationSeconds: undefined };
  }
  const single = accepted.find((t) => t.metrics.duration >= PROMPT_SINGLE_MIN_SEC && t.metrics.duration <= PROMPT_SINGLE_MAX_SEC);
  const chosen: Take[] = [];
  if (single) {
    chosen.push(single);
  } else {
    let total = 0;
    for (const t of accepted) {
      chosen.push(t);
      total += t.metrics.duration + PROMPT_GAP_SEC;
      if (total >= PROMPT_CONCAT_TARGET_SEC) break;
    }
  }
  const parts: Int16Array[] = [];
  let sampleRate = 24_000;
  for (const t of chosen) {
    const pcm = readWav(await fs.readFile(path.resolve(ROOT, t.audioPath)));
    sampleRate = pcm.sampleRate;
    if (parts.length) parts.push(new Int16Array(Math.round(sampleRate * PROMPT_GAP_SEC)));
    parts.push(toMono(pcm));
  }
  const length = parts.reduce((n, a) => n + a.length, 0);
  const joined = new Int16Array(length);
  let offset = 0;
  for (const a of parts) {
    joined.set(a, offset);
    offset += a.length;
  }
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(outAbs, writeWav(joined, sampleRate));
  return {
    promptAudioPath: `/audio/uploads/profile-${profile.id}-prompt.wav`,
    promptText: chosen.map((t) => t.text.trim()).join(" "),
    durationSeconds: Math.round((length / sampleRate) * 1000) / 1000,
  };
}

// ---- stats ----

export async function corpusStats(speakerId = DEFAULT_SPEAKER): Promise<CorpusStats> {
  const takes = await getTakes(speakerId);
  const accepted = takes.filter((t) => t.verdict === "accept");
  const byEmotion: Record<string, number> = {};
  const cleanByEmotion: Record<string, number> = {};
  const sentences = new Set<string>();
  const words = new Set<string>();
  let seconds = 0;
  let cleanSeconds = 0;
  let borderlineTakes = 0;
  for (const t of accepted) {
    seconds += t.metrics.duration;
    byEmotion[t.emotion] = (byEmotion[t.emotion] ?? 0) + t.metrics.duration;
    if (t.quality === "borderline") {
      borderlineTakes += 1;
    } else {
      cleanSeconds += t.metrics.duration;
      cleanByEmotion[t.emotion] = (cleanByEmotion[t.emotion] ?? 0) + t.metrics.duration;
    }
    sentences.add(t.promptId);
    for (const w of t.text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) if (w) words.add(w);
  }
  return {
    speakerId,
    takes: takes.length,
    accepted: accepted.length,
    rejected: takes.length - accepted.length,
    acceptedSeconds: Math.round(seconds * 10) / 10,
    acceptedSecondsByEmotion: Object.fromEntries(Object.entries(byEmotion).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    cleanSeconds: Math.round(cleanSeconds * 10) / 10,
    cleanSecondsByEmotion: Object.fromEntries(Object.entries(cleanByEmotion).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    borderlineSeconds: Math.round((seconds - cleanSeconds) * 10) / 10,
    borderlineTakes,
    sentences: sentences.size,
    distinctWords: words.size,
    thresholds: CORPUS_THRESHOLDS,
  };
}

// ---- export (LJSpeech layout + dataset card) ----

export async function exportCorpus(speakerId = DEFAULT_SPEAKER): Promise<{ exportDir: string; card: string; count: number; seconds: number }> {
  const takes = (await getTakes(speakerId)).filter((t) => t.verdict === "accept");
  const dir = path.join(speakerDir(speakerId), "export");
  const wavs = path.join(dir, "wavs");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(wavs, { recursive: true });
  const rows: string[] = [];
  let seconds = 0;
  for (const t of takes) {
    const src = path.resolve(ROOT, t.audioPath);
    const dst = path.join(wavs, `${t.id}.wav`);
    try {
      await fs.symlink(src, dst);
    } catch {
      await fs.copyFile(src, dst);
    }
    rows.push(`${t.id}|${t.text.replace(/\|/g, "/")}|${t.text.replace(/\|/g, "/")}`);
    seconds += t.metrics.duration;
  }
  await fs.writeFile(path.join(dir, "metadata.csv"), rows.join("\n") + (rows.length ? "\n" : ""), "utf-8");
  // Emotion tags next to the LJSpeech file so emotion-conditioned training can read them.
  await fs.writeFile(
    path.join(dir, "emotions.csv"),
    takes.map((t) => `${t.id}|${t.emotion}`).join("\n") + (takes.length ? "\n" : ""),
    "utf-8"
  );
  await fs.writeFile(
    path.join(dir, "quality.csv"),
    takes
      .map((t) => `${t.id}|${t.quality ?? "clean"}|${t.metrics.reverbTailDb ?? ""}|${t.metrics.snrDb}`)
      .join("\n") + (takes.length ? "\n" : ""),
    "utf-8"
  );
  const stats = await corpusStats(speakerId);
  const card = datasetCard(stats, takes);
  await fs.writeFile(path.join(dir, "DATASET_CARD.md"), card, "utf-8");
  return { exportDir: toRepoRelative(dir), card, count: takes.length, seconds: Math.round(seconds * 10) / 10 };
}

function datasetCard(stats: CorpusStats, takes: Take[]): string {
  const dates = takes.map((t) => t.createdAt).sort();
  const first = dates[0]?.slice(0, 10) ?? "–";
  const last = dates[dates.length - 1]?.slice(0, 10) ?? "–";
  const minutes = (stats.acceptedSeconds / 60).toFixed(1);
  const emo = Object.entries(stats.acceptedSecondsByEmotion)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${(v / 60).toFixed(1)} min |`)
    .join("\n");
  return `# Dataset card: speaker "${stats.speakerId}"

Personal speech corpus recorded with Personal Voice Clone Studio (docs/protocol.md §1).

- Speaker id: ${stats.speakerId}
- Recording dates: ${first} to ${last}
- Accepted takes: ${stats.accepted} (${stats.rejected} rejected by QC, kept out of this export)
- Accepted speech: ${minutes} min, of which ${(stats.cleanSeconds / 60).toFixed(1)} min clean and ${(stats.borderlineSeconds / 60).toFixed(1)} min borderline (${stats.borderlineTakes} takes; see \`quality.csv\`)
- Distinct sentences: ${stats.sentences} (CMU ARCTIC prompt set, Kominek & Black 2004)
- Distinct words: ${stats.distinctWords}
- Format: mono 24 kHz 16-bit PCM wav, leading/trailing silence trimmed, no denoising

## Emotion distribution

| emotion | accepted |
|---|---|
${emo || "| – | 0 min |"}

## Quality-control thresholds (every take in this export passed all of them)

| metric | accept when |
|---|---|
| duration | 1.0–30 s |
| peak level | ≤ −1 dBFS, clipping < 0.1 % |
| noise floor | ≤ −45 dB |
| SNR | ≥ 30 dB = clean; 24–30 dB = borderline; < 24 dB rejected |
| reverb tail | ≤ −25 dB = clean; −25…−20 dB = accepted as "borderline"; > −20 dB rejected |
| intelligibility (WER vs prompt, faster-whisper small) | ≤ 0.10 |

Borderline takes are unaltered recordings with mild room sound. No dereverberation or
enhancement was applied to any file. Training jobs exclude borderline takes unless the
job explicitly opts in; the model card records which was used.

## Layout

- \`metadata.csv\`: LJSpeech layout, \`id|text|normalized_text\`
- \`emotions.csv\`: \`id|emotion\`
- \`quality.csv\`: \`id|quality|reverb_tail_db|snr_db\` (quality = clean or borderline)
- \`wavs/<id>.wav\`

## Consent

The speaker recorded this corpus of their own voice, on their own machine, for the purpose
of building and evaluating a personal voice model. It is not to be redistributed, used to
train models for other people, or published without the speaker's explicit consent.

## License

TBD by the speaker.
`;
}
