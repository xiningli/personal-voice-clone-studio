// Shared contract between the Next.js app, its API routes and the CosyVoice backend.

export type Language = "zh" | "en" | "auto";

export type TTSMode = "auto" | "zero_shot" | "instruct" | "instruct_ref" | "cross_lingual";

/**
 * A profile is a quality-controlled recording session for one emotion: its accepted takes
 * (docs/protocol.md §1) are the corpus, and the prompt the model clones from is DERIVED from
 * them (lib/corpus.ts rebuildProfilePrompt), never uploaded raw.
 */
export interface VoiceProfile {
  id: string;
  name: string;
  description: string;
  /** Kept for old records; new profiles have no single source upload (takes do). */
  referenceAudioPath: string;
  /** Derived prompt: best accepted take (5–15 s) or a concatenation; mono 24 kHz PCM. Empty until a take is accepted. */
  promptAudioPath: string;
  /** Transcript of promptAudioPath: the QC-verified text of the take(s) it was built from. */
  promptText: string;
  language: Language;
  /** Emotion every take of this profile is read with (neutral, happy, warm, ...). Zero-shot
   *  mode clones the delivery, so an emotion-specific profile is the most faithful way to get
   *  that emotion without an instruct string. */
  emotion: string;
  durationSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

/** What GET /api/tts/profiles returns: the profile plus its corpus counters. */
export interface VoiceProfileSummary extends VoiceProfile {
  acceptedTakes: number;
  rejectedTakes: number;
  acceptedSeconds: number;
}

export interface VoiceStylePreset {
  id: string;
  name: string;
  description: string;
  speed: number;
  /** Natural-language prosody instruction handed to CosyVoice2's instruct path. */
  instruct: string;
  contentType: string;
  language: Language | "any";
  /** Emotion bank/profile the preset's wording maps to (derived by the API; null = situational). */
  emotion?: string | null;
}

export interface GeneratedAudio {
  id: string;
  filename: string;
  path: string;
  duration: number;
  format: "wav";
  voiceProfileId: string;
  stylePresetId?: string;
  instruct?: string;
  speed?: number;
  seed?: number;
  mode?: TTSMode;
  elapsedSeconds?: number;
  createdAt: string;
}

export interface TTSRequest {
  text: string;
  voiceProfileId: string;
  speed: number;
  instruct: string;
  seed?: number;
  mode?: TTSMode;
  format: "wav";
}

export interface TTSResponse {
  audioUrl: string;
  duration: number;
  format: string;
}

// ---- Arena: human-preference collection over prosody variants ----

export interface ArenaVariant {
  instruct: string;
  speed: number;
  seed?: number;
  presetId?: string;
  /** Backend model id to synthesize with (duel rounds); omitted = whatever is loaded. */
  model?: string;
}

export interface ArenaCandidate extends ArenaVariant {
  id: string;
  /** Blind label shown before reveal: "A", "B", "C"... assigned in shuffled order. */
  label: string;
  seed: number;
  audioPath: string;
  duration: number;
  elapsedSeconds: number;
  /** Objective metrics computed after generation (docs/protocol.md §2). */
  metrics?: CandidateMetrics;
  /** Set on anchor trials: this candidate is a real recording, not synthesis. */
  isRecording?: boolean;
  takeId?: string;
  /** Backend model id that made this candidate (from the x-model header). */
  model?: string;
}

export interface ArenaRound {
  id: string;
  createdAt: string;
  profileId: string;
  text: string;
  candidates: ArenaCandidate[];
  /** Line-bank category when the round was sampled (lecture, greeting, ...). */
  category?: string;
  /** True when line, instructs and seed were drawn by the sampler rather than typed. */
  sampled?: boolean;
  /** Backend model id that synthesized the candidates (e.g. FunAudioLLM/Fun-CosyVoice3-0.5B-2512). */
  model?: string;
  /** test (default) | repeat (re-served pair, reliability) | anchor (real recording vs synthesis) | duel (two checkpoints). */
  trial?: TrialType;
  /** For repeat trials: the round whose pair was re-served. */
  repeatOf?: string;
  /** For duel trials: the two checkpoint ids compared (`model` is "duel" so BT never pools them). */
  models?: string[];
}

export interface CandidateRating {
  naturalness: number; // 1-5
  emotion: number; // 1-5 how well it matches the intended tone
  similarity: number; // 1-5 how much it sounds like the owner
}

export interface ArenaVote {
  id: string;
  roundId: string;
  createdAt: string;
  /** Candidate id of the winner; null means no preference / all rejected. */
  winnerId: string | null;
  ratings: Record<string, CandidateRating>;
  /** Round-level remark. */
  notes: string;
  /** Per-candidate remarks keyed by candidate id ("sounds Texan", "breath at the start"). */
  candidateNotes?: Record<string, string>;
}

export interface InstructStats {
  instruct: string;
  presetId?: string;
  rounds: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  elo: number;
  avgNaturalness: number | null;
  avgEmotion: number | null;
  avgSimilarity: number | null;
}

export interface PreferenceSide {
  candidateId: string;
  /** Blind label the listener saw (A/B/C…), so a remark that says "B" is resolvable. */
  label: string;
  instruct: string;
  speed: number;
  seed: number;
  audioPath: string;
  note: string;
  metrics?: CandidateMetrics;
  /** Backend model that made this side (differs between sides only in duel rounds). */
  model?: string;
}

/** One DPO-style preference pair, as exported by /api/arena/export. */
export interface PreferencePair {
  roundId: string;
  voteId: string;
  profileId: string;
  /** Line-bank category of the round, or "manual". */
  category: string;
  /** Backend model that synthesized both sides. Never mix models when training. */
  model: string;
  trial: TrialType;
  text: string;
  chosen: PreferenceSide;
  rejected: PreferenceSide;
  ratings: { chosen: CandidateRating | null; rejected: CandidateRating | null };
  /** Round-level remark; per-candidate remarks live on each side as `note`. */
  notes: string;
  createdAt: string;
}

// ---- Corpus collection (docs/protocol.md §1) ----

export type TakeVerdict = "accept" | "reject";
/** clean = passed every limit; borderline = accepted, but the reverb tail sits in the
 *  −25…−20 dB band. Counted separately and excluded from training unless opted in. */
export type TakeQuality = "clean" | "borderline";

export interface TakeMetrics {
  duration: number;
  peakDbfs: number;
  clippingRatio: number;
  noiseFloorDb: number;
  snrDb: number;
  reverbTailDb: number | null;
  wer: number;
  wordErrors?: number;
  refWords?: number;
  transcript: string;
}

export interface Take {
  id: string;
  speakerId: string;
  sessionId: string;
  promptId: string; // e.g. arctic_a0001, or a reading-script id
  /** The voice profile this take was recorded for. */
  profileId?: string;
  text: string;
  emotion: string; // "neutral" or an EMOTIONS id
  language: Language;
  audioPath: string; // datasets/<speakerId>/wavs/<id>.wav (absolute or repo-relative)
  sourcePath: string; // the raw upload
  metrics: TakeMetrics;
  verdict: TakeVerdict;
  reasons: string[]; // failing metrics, empty when accepted
  quality?: TakeQuality; // accepted takes only; missing on old records = clean
  warnings?: string[]; // soft findings on accepted takes (why it is borderline)
  createdAt: string;
}

export interface CorpusStats {
  speakerId: string;
  takes: number;
  accepted: number;
  rejected: number;
  acceptedSeconds: number; // clean + borderline
  acceptedSecondsByEmotion: Record<string, number>;
  cleanSeconds: number;
  cleanSecondsByEmotion: Record<string, number>;
  borderlineSeconds: number;
  borderlineTakes: number;
  sentences: number;
  distinctWords: number;
  thresholds: { zeroShotProfileSec: number; sftSec: number; sftRecommendedSec: number; emotionSftSec: number; dpoPairs: number };
}

// ---- Evaluation rigor (docs/protocol.md §2) ----

/**
 * test   = same text, different instructions (instruction preference → Bradley-Terry)
 * seed   = same text, same instruction, different seeds (sample preference → DPO pairs)
 * repeat = a re-served pair (rater reliability)
 * anchor = a real recording against synthesis (similarity ceiling)
 * duel   = same text/instruction/seed on two checkpoints (checkpoint comparison)
 */
export type TrialType = "test" | "seed" | "repeat" | "anchor" | "duel";

export interface CandidateMetrics {
  wer: number | null;
  transcript?: string;
  speakerSimilarity: number | null; // CAM++ cosine vs the profile prompt
  reverbTailDb: number | null;
  duration: number;
}

export interface BradleyTerryEntry {
  instruct: string;
  presetId?: string;
  score: number; // BT strength, log scale, mean-centred
  ci95: [number, number];
  wins: number;
  losses: number;
  rounds: number;
  avgNaturalness: number | null;
  avgEmotion: number | null;
  avgSimilarity: number | null;
  avgWer: number | null;
  avgSpeakerSimilarity: number | null;
}

/** Pairwise checkpoint comparison from duel trials (docs/protocol.md §2). */
export interface DuelStats {
  models: [string, string];
  rounds: number;
  decided: number;
  winsA: number;
  winsB: number;
  ties: number;
  winRateA: number | null;
  /** Wilson 95 % interval for winRateA. */
  ci95: [number, number] | null;
  meanRatingsByModel: Record<string, { naturalness: number | null; emotion: number | null; similarity: number | null }>;
  meanWerByModel: Record<string, number | null>;
  meanSpkSimByModel: Record<string, number | null>;
}

export interface RaterReliability {
  repeatTrials: number;
  repeatAgreement: number | null; // fraction of repeat trials where the same instruct won
  anchorTrials: number;
  anchorAccuracy: number | null; // fraction where the real recording won on similarity
}

// ---- Training (docs/protocol.md §3) ----

export type TrainingStage = "sft" | "dpo";
export type TrainingStatus = "queued" | "preparing" | "training" | "averaging" | "assembling" | "done" | "failed" | "cancelled";

export interface TrainingJob {
  id: string;
  stage: TrainingStage;
  status: TrainingStatus;
  name: string; // becomes models/<name>
  baseModel: string; // HF id or checkpoint dir the job started from
  speakerId: string;
  config: Record<string, unknown>; // epochs, lr, held-out fraction, seed, pair count...
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  step?: number;
  totalSteps?: number;
  trainLoss?: number;
  cvLoss?: number;
  logTail: string[];
  outputDir?: string;
  error?: string;
}

export interface ModelEntry {
  id: string; // what to pass to select: HF id or absolute dir
  name: string;
  kind: "base" | "finetuned";
  stage?: TrainingStage;
  baseModel?: string;
  createdAt?: string;
  active: boolean;
}

// ---- Export (docs/protocol.md §5): a fine-tuned checkpoint as a self-contained voice service ----
export interface ExportBundle {
  name: string;
  dir: string;
  bytes: number;
  createdAt?: string;
  model?: string;
  profiles: number;
}

export interface ExportJob {
  id: string;
  name: string;
  modelId: string;
  status: "queued" | "copying" | "pushing" | "done" | "failed";
  step: string;
  error?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  bundleDir: string;
  push?: { host: string; path?: string } | null;
  bytesCopied: number;
  bytesTotal: number;
  logTail: string[];
}
