# Personal Voice Clone Studio — Claude Code Guide

Personal voice-cloning workbench: Next.js 16 app + FastAPI backend around **CosyVoice3** (default `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`; CosyVoice2 via `STUDIO_TTS_MODEL`).
Goal: find the instruct strings (语气语调) that make the owner's cloned voice sound right,
collect human preference data on them (arena), and hand the winners to a downstream digital
human.

## Running

```bash
bash backend/run.sh          # CosyVoice3 on 127.0.0.1:8010 (venv/checkout via scripts/local-env.sh or STUDIO_* env vars)
npm run dev                  # Next.js on https://localhost:3010 (self-signed cert in certs/; needed for the microphone)
```

Ports 8000 and 3000 are taken by another project on the maintainer's machine. Never kill
what is listening there. Stop the backend with `pkill -f "[b]ackend/server.py"`.

CosyVoice2 needs about 2.5 GiB of VRAM; `POST /v1/unload` frees it before training or
before another GPU-heavy service starts.

## Contract

`lib/types.ts` is the single source of truth for the Next.js API and UI. The backend
endpoints (`backend/server.py`):

| Method | Route | Body / result |
|--------|-------|---------------|
| POST | `/v1/tts` | `{text, reference_audio, prompt_text, instruct, speed, seed, mode, trim_breath}` → wav; headers `x-model`, `x-sample-rate`, `x-audio-duration`, `x-elapsed-seconds`, `x-seed`, `x-mode`, `x-trimmed-ms` |
| POST | `/v1/prepare` | `{source_audio, out_wav, transcript?, language, max_seconds, process}` → `{prompt_wav, transcript, transcript_source, duration, language, segment}` |
| GET | `/health` | `{ready, loading, error, model, device, gpu_free_gib, cached_speakers}` |
| POST | `/v1/load`, `/v1/unload` | load / free the model |
| GET | `/v1/profiles` | reference clips with absolute wav paths on this machine (the studio's data file, or an exported bundle's `profiles.json` via `STUDIO_PROFILES_FILE`) |
| GET/POST | `/v1/export/bundles`, `/v1/export`, `/v1/export/jobs/{id}` | export a checkpoint as a self-contained service, optionally rsync it to `user@host` (backend/export.py) |

CosyVoice3 needs `You are a helpful assistant.<|endofprompt|>` in front of the reference
transcript (zero-shot), the instruction (instruct) or the text (cross-lingual); the backend
adds it when the model id contains "CosyVoice3".

`mode`: `auto` (instruct if given, else zero_shot if transcript, else cross_lingual),
`zero_shot`, `instruct`, `instruct_ref`, `cross_lingual`. `instruct` mode is assembled by hand in
`Engine._instruct_base` because `CosyVoice2.inference_instruct2` ignores the instruction
when a cached speaker id is passed. `instruct_ref` keeps the clip's speech tokens in the LM
prompt as well (measured: the clip's prosody then wins and the instruction barely shows;
kept for arena comparisons).

Next.js routes:

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/api/tts/profiles` | list with corpus counters / create: JSON `{name, language, emotion, description?}` (empty profile) or multipart `name, language, emotion, transcript, audio` (clip goes through QC as a take) |
| GET/PUT/POST/DELETE | `/api/tts/profiles/[id]` | read with takes / edit name, description, language, emotion / rebuild derived prompt / delete profile + its takes + prompt |
| POST | `/api/tts/generate` | `{text, voiceProfileId, speed, instruct, seed?, mode?, stylePresetId?}` → `{audioFiles}` |
| GET | `/api/tts/health` | proxied backend health + `reachable` |
| GET | `/api/presets` | `styles/voice-presets.json` |
| GET/POST | `/api/arena/rounds` | rounds; POST `{profileId, text, variants:[{instruct, speed, seed?, presetId?}]}` (manual) |
| POST | `/api/arena/random` | sampled round `{category?: any\|<bank id>, n?: 2-4, profileId?: id\|random, trial?, repeatOf?, duel?: {models: [a, b]}}` — `duel` compares two checkpoints on one line/instruction/seed |
| GET | `/api/arena/bank` | line-bank categories |
| GET/POST | `/api/arena/votes` | votes; POST `{roundId, winnerId|null, ratings, notes}` |
| GET | `/api/arena/stats?model=` | per-instruct W/L/T, win rate, Elo, avg ratings; one backend model at a time (default newest), `all` pools |
| GET | `/api/arena/export` | `preference-pairs.jsonl` (`?format=json` for an array) |
| GET | `/api/arena/export/digital-human` | per-profile prompt path, transcript, top instructs |
| GET/POST/DELETE | `/api/corpus/{prompts,takes,takes/[id],stats,export}` | §1 corpus: `prompts?profileId=` (emotion script first, then ARCTIC), QC'd takes under `datasets/<speaker>/` carrying `profileId` (an accepted take rebuilds the profile's prompt), readiness, LJSpeech export |
| POST | `/api/arena/metrics` | backfill WER / CAM++ similarity on candidates |
| GET | `/api/report` | Markdown report (BT ± CI per model, reliability) |
| * | `/api/train/{sft,dpo,jobs,jobs/[id],jobs/[id]/cancel}`, `/api/models`, `/api/models/select` | §3 training jobs and checkpoint switching |
| GET/POST | `/api/export`, `/api/export/jobs/[id]` | §5 export bundles and jobs |

Backend feature modules (mounted by server.py): `backend/qc.py` (`POST /v1/qc`), `backend/metrics.py`
(`POST /v1/metrics`), `backend/train.py` (`/v1/train/*`, `/v1/models`, `/v1/models/select`).
Methodology: `docs/protocol.md`. Pages: `/voices` (profiles = corpus), `/generate`, `/arena`, `/train`, `/export`.

`STUDIO_TTS_HOST` (default 127.0.0.1) is the bind address; an exported bundle's `run.sh` sets 0.0.0.0.

## Common jobs

**Generate a line in the owner's voice with a given tone**

```bash
curl -X POST http://localhost:3010/api/tts/generate -H 'Content-Type: application/json' -d '{
  "text": "欢迎来到今天的课程。", "voiceProfileId": "<id from data/voice-profiles.json>",
  "instruct": "用温暖、亲切的语气说这句话。", "speed": 0.95, "seed": 7, "mode": "auto", "format": "wav"}'
```

**Run an arena round from the CLI** — POST `/api/arena/rounds` with 2–6 variants, then
POST `/api/arena/votes`. Same seed across variants isolates the effect of the instruct.

**Import the owner's reference** — `bash scripts/import-reference.sh <prompt.wav> <prompt.txt>`
(defaults to `datasets/voice-reference/processed/`, converted only, not re-denoised).

**Add a preset** — edit `styles/voice-presets.json` (`instruct`, `speed`, `language`).

## Data (all ignored by git)

- `data/voice-profiles.json` — profiles; `promptAudioPath` + `promptText` are what the model clones from
- `data/arena-rounds.json`, `data/arena-votes.jsonl` — preference data
- `public/audio/uploads/` (sources + prepared prompts), `generated/`, `arena/`

Reference audio and everything synthesized from it are personal. Never commit, upload or
log them.

## Verification

```bash
npx tsc --noEmit && npx eslint .
curl -s http://127.0.0.1:8010/health
```
