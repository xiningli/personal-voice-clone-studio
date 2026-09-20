/**
 * Source of truth for the /api-docs page. Every entry mirrors a real route under app/api/**
 * (the app, https://<host>:3010) or a real endpoint in backend/*.py (the internal CosyVoice
 * server on http://127.0.0.1:8010). `{ORIGIN}` in examples is replaced with the page's origin
 * at render time. Keep bodies and response shapes in step with the routes.
 */

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface Endpoint {
  method: Method;
  path: string;
  summary: string;
  /** Request body / query params / multipart fields, as a short spec. */
  request?: string;
  /** Response shape, as a short spec. */
  response: string;
  /** Copy-paste example. `{ORIGIN}` and `{BACKEND}` are substituted at render time. */
  curl: string;
  notes?: string;
}

export interface Section {
  id: string;
  title: string;
  intro?: string;
  endpoints: Endpoint[];
}

export const APP_PORT = 3010;
export const BACKEND = "http://127.0.0.1:8010";

export const APP_SECTIONS: Section[] = [
  {
    id: "health",
    title: "Health",
    endpoints: [
      {
        method: "GET",
        path: "/api/tts/health",
        summary: "Is the CosyVoice backend reachable, which model is loaded, is it ready.",
        response:
          "{ endpoint, reachable: boolean, status, model, model_dir, ready, loading, error, load_seconds, cached_speakers, device, gpu_free_gib, gpu_total_gib }",
        curl: "curl -k {ORIGIN}/api/tts/health",
      },
    ],
  },
  {
    id: "models",
    title: "Models",
    intro:
      "The backend has exactly one model loaded at a time. Selecting another one unloads the current model and loads the new one (a few seconds); every arena round and generated file afterwards records the new id.",
    endpoints: [
      {
        method: "GET",
        path: "/api/models",
        summary: "Base models and fine-tuned checkpoints known to the backend.",
        response:
          '[{ id, name, kind: "base" | "finetuned", stage?: "sft" | "dpo", baseModel?, createdAt?, active: boolean }]',
        curl: "curl -k {ORIGIN}/api/models",
        notes: "`id` is what you pass to select: a Hugging Face id for base models, an absolute directory under models/ for fine-tunes.",
      },
      {
        method: "POST",
        path: "/api/models/select",
        summary: "Hot-swap the loaded model.",
        request: "{ id: string }",
        response: "the backend's /v1/models/select result (the new active id); refused with an error while a training job is running",
        curl: `curl -k -X POST {ORIGIN}/api/models/select \\
  -H 'Content-Type: application/json' \\
  -d '{"id":"FunAudioLLM/Fun-CosyVoice3-0.5B-2512"}'`,
      },
    ],
  },
  {
    id: "profiles",
    title: "Voice profiles",
    intro:
      "A profile is one category (emotion, language) of the owner's recordings. Its promptAudioPath is the reference clip the model clones from; only profiles with a non-empty promptAudioPath can be used for generation.",
    endpoints: [
      {
        method: "GET",
        path: "/api/tts/profiles",
        summary: "All profiles with their corpus counters.",
        response:
          "[{ id, name, description, language: \"en\" | \"zh\", emotion, promptAudioPath, promptText, durationSeconds?, acceptedTakes, rejectedTakes, acceptedSeconds, createdAt, updatedAt }]",
        curl: "curl -k {ORIGIN}/api/tts/profiles",
      },
      {
        method: "GET",
        path: "/api/tts/profiles/{id}",
        summary: "One profile plus every take of its category.",
        response: "{ ...profile, takes: Take[] }",
        curl: "curl -k {ORIGIN}/api/tts/profiles/<profile-id>",
      },
    ],
  },
  {
    id: "generate",
    title: "Generate speech",
    intro:
      "The main entry point for other programs. The wav lands under public/audio/generated and is served by the app, so `{ORIGIN}` + `path` is a downloadable URL.",
    endpoints: [
      {
        method: "POST",
        path: "/api/tts/generate",
        summary: "Synthesize text in a profile's voice with an optional tone instruction.",
        request:
          '{ text: string, voiceProfileId: string, instruct?: string (default ""), speed?: number (0.7–1.3, default 1.0), seed?: number, mode?: "auto" | "zero_shot" | "instruct" | "instruct_ref" | "cross_lingual" (default "auto"), stylePresetId?: string, format: "wav" }',
        response:
          "{ audioFiles: [{ id, filename, path, duration, format: \"wav\", voiceProfileId, stylePresetId?, instruct, speed, seed, mode, elapsedSeconds, createdAt }] } — one entry per ~500-character chunk of the text",
        curl: `curl -k -X POST {ORIGIN}/api/tts/generate \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"Welcome back. Today we build on loops with functions.",
       "voiceProfileId":"<profile-id>",
       "instruct":"Speak warmly and slowly.",
       "speed":1.0,"seed":7,"mode":"auto","format":"wav"}'
# then download the wav:
curl -k -o line.wav "{ORIGIN}<audioFiles[0].path>"`,
        notes:
          "`mode: auto` = instruct when `instruct` is non-empty, else zero-shot with the profile's transcript. Same seed + same inputs = byte-identical audio. Errors: 400 (missing text/profile), 404 (unknown profile), 409 (profile has no prepared prompt), 502 (backend failure; partial audioFiles included).",
      },
    ],
  },
  {
    id: "presets",
    title: "Style presets",
    endpoints: [
      {
        method: "GET",
        path: "/api/presets",
        summary: "The instruction presets from styles/voice-presets.json, each with the emotion bank it maps to.",
        response: '[{ id, name, description, speed, instruct, contentType, language: "en" | "zh" | "any", emotion: string | null }]',
        curl: "curl -k {ORIGIN}/api/presets",
      },
      {
        method: "GET",
        path: "/api/presets/sample?presetId=",
        summary: "A random sentence whose content fits the preset (any lecture line when presetId is omitted).",
        response: "{ text, source }",
        curl: "curl -k '{ORIGIN}/api/presets/sample?presetId=happy-en'",
      },
    ],
  },
  {
    id: "arena",
    title: "Arena (blind evaluation)",
    intro:
      "Rounds are pairs (or small sets) of candidates for one line, shown under shuffled labels; votes become preference data. Trial types: test (two instructions), seed (same instruction, two seeds → DPO pairs), repeat (reliability), anchor (real recording vs synthesis), duel (two checkpoints).",
    endpoints: [
      {
        method: "POST",
        path: "/api/arena/random",
        summary: "Sample a round (the 🎲 button).",
        request:
          '{ category?: "any" | "lecture" | "greeting" | "question" | "thinking" | "explanation" | "encouragement" | "summary", n?: 2–4, profileId?: string | "random", trial?: "test" | "seed" | "repeat" | "anchor", repeatOf?: roundId, duel?: { models: [idA, idB] } }',
        response: "ArenaRound { id, createdAt, profileId, text, category, trial, model, models?, sampled, candidates: [{ id, label, instruct, speed, seed, model?, audioPath, duration, elapsedSeconds, metrics? }] }",
        curl: `curl -k -X POST {ORIGIN}/api/arena/random \\
  -H 'Content-Type: application/json' \\
  -d '{"category":"greeting","n":2,"profileId":"random"}'`,
        notes: "Generation is sequential on one GPU: expect 5–15 s for two candidates, ~40 s for a duel (two model switches).",
      },
      {
        method: "POST",
        path: "/api/arena/rounds",
        summary: "Hand-written round.",
        request: "{ profileId, text, variants: [{ instruct, speed, seed?, presetId?, model? }] } (2–6 variants)",
        response: "ArenaRound",
        curl: `curl -k -X POST {ORIGIN}/api/arena/rounds \\
  -H 'Content-Type: application/json' \\
  -d '{"profileId":"<profile-id>","text":"Hi, welcome in.",
       "variants":[{"instruct":"","speed":1},{"instruct":"Speak warmly.","speed":1}]}'`,
      },
      {
        method: "GET",
        path: "/api/arena/votes",
        summary: "All votes.",
        response: "[ArenaVote]",
        curl: "curl -k {ORIGIN}/api/arena/votes",
      },
      {
        method: "POST",
        path: "/api/arena/votes",
        summary: "Record a judgment on a round.",
        request:
          "{ roundId, winnerId: candidateId | null, ratings?: { [candidateId]: { naturalness, emotion, similarity } } (integers 1–5), notes?: string, candidateNotes?: { [candidateId]: string } }",
        response: "ArenaVote { id, roundId, createdAt, winnerId, ratings, notes, candidateNotes }",
        curl: `curl -k -X POST {ORIGIN}/api/arena/votes \\
  -H 'Content-Type: application/json' \\
  -d '{"roundId":"<round-id>","winnerId":"<candidate-id>",
       "candidateNotes":{"<candidate-id>":"accent: slight drawl; want neutral"}}'`,
      },
      {
        method: "GET",
        path: "/api/arena/stats?model=",
        summary: "Leaderboard: Bradley-Terry per instruction, Elo, rater reliability, checkpoint duels.",
        request: "?model=<id> (default: the model of the newest round; \"all\" pools) &bootstrap=<resamples, default 1000>",
        response: "{ model, models, totalRounds, totalVotes, trials, stats (Elo), bt (Bradley-Terry with ci95), reliability, duels, bootstrap }",
        curl: "curl -k '{ORIGIN}/api/arena/stats?model=all'",
      },
      {
        method: "GET",
        path: "/api/arena/export",
        summary: "Preference pairs (chosen / rejected) for training.",
        request: "?format=json for an array; default is JSONL download",
        response: "one PreferencePair per line: { roundId, voteId, profileId, category, model, trial, text, chosen: { candidateId, label, instruct, speed, seed, model?, audioPath, note, metrics? }, rejected: {...}, ratings, notes, createdAt }",
        curl: "curl -k -o preference-pairs.jsonl {ORIGIN}/api/arena/export",
      },
      {
        method: "GET",
        path: "/api/arena/export/digital-human",
        summary: "Per profile: prompt path, transcript and the top-ranked instructions, for a downstream digital human.",
        response: "{ generatedAt, profiles: [{ profileId, name, promptAudioPath, promptText, language, topInstructs: [{ instruct, elo, winRate, rounds, ... }] }] }",
        curl: "curl -k {ORIGIN}/api/arena/export/digital-human",
      },
    ],
  },
  {
    id: "corpus",
    title: "Corpus (recordings)",
    intro: "Every take goes through the backend's quality control; only accepted takes count. Recordings live under datasets/<speaker>/ and are served only through these routes.",
    endpoints: [
      {
        method: "GET",
        path: "/api/corpus/stats",
        summary: "Readiness: accepted minutes overall, per emotion, clean vs borderline, and the training thresholds.",
        response: "{ speakerId, takes, accepted, rejected, acceptedSeconds, acceptedSecondsByEmotion, cleanSeconds, cleanSecondsByEmotion, borderlineSeconds, borderlineTakes, sentences, distinctWords, thresholds }",
        curl: "curl -k {ORIGIN}/api/corpus/stats",
      },
      {
        method: "GET",
        path: "/api/corpus/prompts?profileId=",
        summary: "The next sentences to read for a profile: its emotion script first, then its sentence bank, skipping sentences already accepted.",
        request: "?profileId=<id>&n=<count, default 10>  (or ?emotion=<id>&n= without a profile)",
        response: "[{ id, text, estSeconds }]",
        curl: "curl -k '{ORIGIN}/api/corpus/prompts?profileId=<profile-id>&n=5'",
      },
      {
        method: "POST",
        path: "/api/corpus/takes",
        summary: "Upload one recording of one sentence; it is decoded, trimmed, measured, transcribed and judged.",
        request: "multipart/form-data: audio (file), promptId, text, profileId (its emotion/language are used), sessionId?, speaker?",
        response: 'Take { id, promptId, text, emotion, language, verdict: "accept" | "reject", quality?: "clean" | "borderline", reasons, warnings?, metrics: { duration, peakDbfs, clippingRatio, noiseFloorDb, snrDb, reverbTailDb, wer, transcript }, audioPath, createdAt }',
        curl: `curl -k -X POST {ORIGIN}/api/corpus/takes \\
  -F 'audio=@take.wav;type=audio/wav' \\
  -F 'promptId=arctic_a0001' \\
  -F 'text=Author of the danger trail, Philip Steels, etc.' \\
  -F 'profileId=<profile-id>'`,
      },
      {
        method: "GET",
        path: "/api/corpus/export",
        summary: "Write an LJSpeech-layout dataset (metadata.csv, wavs/, quality.csv, DATASET_CARD.md) under datasets/<speaker>/export.",
        response: "{ exportDir, card, count, seconds }",
        curl: "curl -k {ORIGIN}/api/corpus/export",
      },
    ],
  },
  {
    id: "export",
    title: "Export",
    intro:
      "Package a fine-tuned checkpoint as a self-contained voice service (model files copied, reference clips, this backend, install/run scripts, a systemd unit) and optionally push it to a server with rsync over SSH. The remote install is two commands the job prints.",
    endpoints: [
      {
        method: "GET",
        path: "/api/export",
        summary: "Bundles under exports/ and export jobs.",
        response: "{ bundles: [{ name, dir, bytes, createdAt, model, profiles }], jobs: [ExportJob] }",
        curl: "curl -k {ORIGIN}/api/export",
      },
      {
        method: "POST",
        path: "/api/export",
        summary: "Start an export; one at a time.",
        request: "{ modelId (fine-tuned checkpoint dir), name?, profileIds?: string[] (default: every prepared profile), push?: { host: \"user@host\", path?: \"~/voice-service\" } }",
        response: "ExportJob { id, name, modelId, status: queued | copying | pushing | done | failed, step, bytesCopied, bytesTotal, push, logTail }",
        curl: `curl -k -X POST {ORIGIN}/api/export \\
  -H 'Content-Type: application/json' \\
  -d '{"modelId":"/path/to/personal-voice-clone-studio/models/owner-sft-v2","push":{"host":"user@your-server","path":"~/voice-service"}}'`,
        notes: "The exported service answers GET /v1/profiles with the reference clips and their paths on that machine, so clients on other hosts (your other apps) need none of the studio's files: set their STUDIO_TTS_URL to the server.",
      },
      {
        method: "GET",
        path: "/api/export/jobs/{id}",
        summary: "One export job with its last 60 log lines.",
        response: "ExportJob",
        curl: "curl -k {ORIGIN}/api/export/jobs/<job-id>",
      },
    ],
  },
  {
    id: "training",
    title: "Training",
    intro: "Jobs run on the backend, one at a time. Stage A (SFT) adapts the CosyVoice LLM to the corpus; stage B (DPO) optimizes a checkpoint on same-instruction arena pairs. Both need ~10 GB of free VRAM.",
    endpoints: [
      {
        method: "POST",
        path: "/api/train/sft",
        summary: "Start speaker-adaptation SFT on the accepted takes.",
        request: "{ name, speakerId? (default \"owner\"), baseModel?, epochs?, lr?, heldoutFraction?, seed?, trainFlow?, includeBorderline? }",
        response: "TrainingJob { id, stage: \"sft\", status, name, baseModel, speakerId, config, createdAt, ... }",
        curl: `curl -k -X POST {ORIGIN}/api/train/sft \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"owner-sft-v3","epochs":3,"lr":0.000002,"heldoutFraction":0.1,"includeBorderline":true}'`,
      },
      {
        method: "POST",
        path: "/api/train/dpo",
        summary: "Start DPO from a checkpoint on the decided same-instruction pairs made with it.",
        request: "{ name, baseModel (checkpoint dir or model id), refModel?, beta?, epochs?, lr?, force? (bypass the 200-pair minimum) }",
        response: "TrainingJob plus pairs (how many qualified)",
        curl: `curl -k -X POST {ORIGIN}/api/train/dpo \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"owner-dpo-v1","baseModel":"/path/to/personal-voice-clone-studio/models/owner-sft-v2"}'`,
      },
      {
        method: "GET",
        path: "/api/train/jobs",
        summary: "All jobs, newest first.",
        response: "[TrainingJob { id, stage, status, name, baseModel, config, step?, epoch?, trainLoss?, cvLoss?, logTail, outputDir?, error? }]",
        curl: "curl -k {ORIGIN}/api/train/jobs",
      },
      {
        method: "GET",
        path: "/api/train/jobs/{id}",
        summary: "One job with the last 60 log lines.",
        response: "TrainingJob",
        curl: "curl -k {ORIGIN}/api/train/jobs/<job-id>",
      },
      {
        method: "POST",
        path: "/api/train/jobs/{id}/cancel",
        summary: "Cancel a running job.",
        response: "TrainingJob",
        curl: "curl -k -X POST {ORIGIN}/api/train/jobs/<job-id>/cancel",
      },
    ],
  },
  {
    id: "report",
    title: "Report",
    endpoints: [
      {
        method: "GET",
        path: "/api/report",
        summary: "Markdown report: evaluation tables per model with confidence intervals, rater reliability, objective metrics.",
        request: "?bootstrap=<resamples, default 1000>",
        response: "text/markdown",
        curl: "curl -k {ORIGIN}/api/report",
      },
    ],
  },
];

export const BACKEND_SECTION: Section = {
  id: "backend",
  title: "Direct backend (same machine only)",
  intro:
    "The FastAPI server in backend/server.py listens on 127.0.0.1:8010 and is what the app routes above call. Use it directly only from this machine; file arguments are absolute paths on this machine.",
  endpoints: [
    {
      method: "GET",
      path: "/health",
      summary: "Model and GPU state.",
      response: "{ status, model, model_dir, ready, loading, error, load_seconds, cosyvoice_repo, cached_speakers, port, device, gpu_free_gib, gpu_total_gib }",
      curl: "curl {BACKEND}/health",
    },
    {
      method: "POST",
      path: "/v1/tts",
      summary: "Synthesize one text with a reference clip; returns wav bytes.",
      request:
        '{ text (≤4000 chars), reference_audio (absolute wav path), prompt_text?: transcript of the clip, instruct?: string (≤300), speed?: 0.5–2.0, seed?: int, mode?: "auto" | "zero_shot" | "instruct" | "instruct_ref" | "cross_lingual", trim_breath?: bool (default true) }',
      response: "audio/wav body; headers x-model, x-sample-rate, x-audio-duration, x-elapsed-seconds, x-seed, x-mode, x-trimmed-ms",
      curl: `curl -o line.wav -D headers.txt -X POST {BACKEND}/v1/tts \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"Hi, welcome in.",
       "reference_audio":"/path/to/personal-voice-clone-studio/public/audio/uploads/profile-<id>-prompt.wav",
       "prompt_text":"<transcript of that clip>",
       "instruct":"Speak warmly.","seed":7}'`,
    },
    {
      method: "POST",
      path: "/v1/load",
      summary: "Load the configured model if it is not loaded.",
      response: "{ ready, load_seconds }",
      curl: "curl -X POST {BACKEND}/v1/load",
    },
    {
      method: "POST",
      path: "/v1/unload",
      summary: "Free the GPU (needed before training).",
      response: "{ ready: false }",
      curl: "curl -X POST {BACKEND}/v1/unload",
    },
    {
      method: "GET",
      path: "/v1/models",
      summary: "Base models and fine-tuned checkpoints under models/.",
      response: "[{ id, name, kind, stage?, baseModel?, createdAt?, active }]",
      curl: "curl {BACKEND}/v1/models",
    },
    {
      method: "POST",
      path: "/v1/models/select",
      summary: "Unload the current model and load another (HF id or checkpoint directory).",
      request: "{ id }",
      response: "{ active id ... }; refused while a training job runs",
      curl: `curl -X POST {BACKEND}/v1/models/select -H 'Content-Type: application/json' \\
  -d '{"id":"/path/to/personal-voice-clone-studio/models/owner-sft-v2"}'`,
    },
    {
      method: "POST",
      path: "/v1/metrics",
      summary: "Objective metrics for a wav: intelligibility and speaker similarity to a reference.",
      request: '{ wav_path, text?: the intended words, reference_wav?: absolute path of the profile prompt, language?: "en" }',
      response: "{ duration, reverb_tail_db, wer, transcript, speaker_similarity (CAM++ cosine, null without reference_wav) }",
      curl: `curl -X POST {BACKEND}/v1/metrics -H 'Content-Type: application/json' \\
  -d '{"wav_path":"/abs/line.wav","text":"Hi, welcome in.","reference_wav":"/abs/prompt.wav"}'`,
    },
    {
      method: "POST",
      path: "/v1/qc",
      summary: "Decode, trim, measure and judge one recording (what /api/corpus/takes calls).",
      request: '{ source_audio (any format, absolute path), out_wav (absolute path to write), text, language?: "en", emotion?: string }',
      response: '{ metrics: { duration, peakDbfs, clippingRatio, noiseFloorDb, snrDb, reverbTailDb, wer, transcript }, verdict: "accept" | "reject", quality: "clean" | "borderline", reasons, warnings, thresholds }',
      curl: `curl -X POST {BACKEND}/v1/qc -H 'Content-Type: application/json' \\
  -d '{"source_audio":"/abs/take.webm","out_wav":"/abs/take.wav","text":"Author of the danger trail, Philip Steels, etc."}'`,
      notes: "GET /v1/qc/thresholds returns the current limits.",
    },
  ],
};

export const RECIPE_STEPS = [
  {
    title: "1. Pick a voice profile",
    body: "List profiles and take the id of one with a non-empty promptAudioPath (the neutral profile is the safe default).",
    curl: "curl -k {ORIGIN}/api/tts/profiles | jq '.[] | select(.promptAudioPath != \"\") | {id, name, emotion}'",
  },
  {
    title: "2. (Optional) choose the model",
    body: "The backend answers with whatever is loaded. To use a fine-tuned checkpoint, select it first; switch back the same way.",
    curl: `curl -k -X POST {ORIGIN}/api/models/select -H 'Content-Type: application/json' \\
  -d '{"id":"/path/to/personal-voice-clone-studio/models/owner-sft-v2"}'`,
  },
  {
    title: "3. Generate and download",
    body: "Post the text with the profile id and an optional instruction, then fetch the wav at the returned path.",
    curl: `curl -k -X POST {ORIGIN}/api/tts/generate -H 'Content-Type: application/json' \\
  -d '{"text":"Hi, welcome in.","voiceProfileId":"<profile-id>","instruct":"Speak warmly.","seed":7,"format":"wav"}' \\
  | jq -r '.audioFiles[0].path' \\
  | xargs -I{} curl -k -o line.wav "{ORIGIN}{}"`,
  },
];

export const RECIPE_PYTHON = `import requests

ORIGIN = "{ORIGIN}"
s = requests.Session()
s.verify = False  # self-signed dev certificate

profiles = s.get(f"{ORIGIN}/api/tts/profiles").json()
profile = next(p for p in profiles if p["promptAudioPath"])

r = s.post(f"{ORIGIN}/api/tts/generate", json={
    "text": "Hi, welcome in.",
    "voiceProfileId": profile["id"],
    "instruct": "Speak warmly.",
    "seed": 7,
    "format": "wav",
}).json()
path = r["audioFiles"][0]["path"]
open("line.wav", "wb").write(s.get(f"{ORIGIN}{path}").content)
print(r["audioFiles"][0]["mode"], r["audioFiles"][0]["seed"], r["audioFiles"][0]["duration"], "s")`;

export const RECIPE_JS = `const ORIGIN = "{ORIGIN}"; // in Node, set NODE_TLS_REJECT_UNAUTHORIZED=0 for the dev certificate

const profiles = await fetch(\`\${ORIGIN}/api/tts/profiles\`).then((r) => r.json());
const profile = profiles.find((p) => p.promptAudioPath);

const { audioFiles } = await fetch(\`\${ORIGIN}/api/tts/generate\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hi, welcome in.", voiceProfileId: profile.id, instruct: "Speak warmly.", seed: 7, format: "wav" }),
}).then((r) => r.json());

const wav = await fetch(\`\${ORIGIN}\${audioFiles[0].path}\`).then((r) => r.arrayBuffer());
// play it, save it, or pipe it into your own player`;
