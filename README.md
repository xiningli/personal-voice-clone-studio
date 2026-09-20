# Personal Voice Clone Studio

> Repository directory: `personal-voice-clone-studio` (the product's former name). Servers, scripts and
> notes point at that path, so the directory keeps its name.

Local-first workbench for cloning your own voice with **CosyVoice3** (CosyVoice2 selectable), steering its
**语气语调** (tone and prosody) with natural-language instructions, and collecting **human
preference data** over those instructions in a blind-listening arena. The winning
instructions and the prepared reference clip can be exported to a downstream digital human
or any other app that consumes the API.

Next.js 16 + TypeScript + Tailwind on the front, a FastAPI server around CosyVoice3 (CosyVoice2
selectable) on the back. Everything stays on this machine: reference recordings, generated audio and votes
live in ignored directories and are never committed.

## Method

The studio implements a fixed protocol, written up in [docs/protocol.md](docs/protocol.md):

1. **Collect** a phonetically balanced corpus (CMU ARCTIC prompts) one sentence at a time,
   with automatic quality control on every take (level, noise floor, SNR, room reverb,
   whisper-checked intelligibility). Only accepted takes enter the dataset.
2. **Evaluate** blind: paired candidates of the same text, prompt and seed under shuffled
   labels; sampled lines and instructions; repeat trials for test-retest reliability and
   anchor trials (a real recording against synthesis); Bradley-Terry ranking with bootstrap
   confidence intervals, partitioned by model; objective WER and CAM++ speaker similarity
   on every candidate.
3. **Fine-tune** CosyVoice3 on that data: speaker-adaptation SFT on the corpus, then DPO on
   the preference pairs, with every checkpoint registered back into the same arena so it is
   judged with the same protocol as the base model.
4. **Report**: a Markdown summary (corpus card, evaluation tables, rater reliability,
   training runs) suitable for a model card or a paper appendix.

## What it does

- **Voice Profiles** — the corpus. One profile per emotion (平静/温暖/开心/兴奋/严肃/沉稳/好奇/低落/惊讶/温柔);
  creating one opens a recording session that shows the emotion's reading script, then CMU ARCTIC
  sentences one at a time. Every take goes through quality control (level, noise floor, SNR, room
  reverb, whisper-checked intelligibility) and is accepted or rejected on the spot with the reason
  explained. The cloning prompt is derived from the accepted takes (best 5–15 s take, or a
  concatenation), never uploaded raw. Readiness meters show progress toward the SFT and DPO
  thresholds; export writes an LJSpeech-layout dataset with a card.
- **TTS Generator** — pick a profile, a style preset or your own instruct string
  (`用温暖亲切的语气说` / `Speak slowly and warmly`), a speed (0.7–1.3, native), an optional
  seed for reproducibility, and a mode.
- **Arena** — press 🎲 and a round is sampled for you: a line from a category bank
  (lecture, greeting, question, thinking aloud, explanation, encouragement, summary), two
  instructions drawn from the English presets with under-tested ones favoured, one shared
  seed. Listen blind (A/B), rate naturalness / emotion match / sounds-like-me, write a note
  under any track, pick the winner, reveal. Leaderboard per backend model (never pooled by
  default), DPO-style `preference-pairs.jsonl` export with category, model, blind label and
  per-track note on each side, and a digital-human export with the top instructions per
  profile. A manual editor for hand-written variants is folded away underneath.
- **Train** — start SFT / DPO jobs, watch logs, register checkpoints, hot-swap the backend.
- **Export** — package a checkpoint with its reference clips and this backend as a standalone voice service, push it to a server over SSH, run it there (systemd unit included) so other machines synthesize without this GPU.

## Modes

| mode | timbre from | prosody from | needs |
|------|-------------|--------------|-------|
| `zero_shot` | reference clip | reference clip | transcript of the clip |
| `instruct` | reference clip | your instruction text | instruct string |
| `instruct_ref` | reference clip + its speech tokens | instruction, then the clip | transcript and instruction (measured: the clip's prosody dominates, the instruction barely shows; kept for comparisons) |
| `cross_lingual` | reference clip | model default | nothing (use when text language ≠ clip language) |
| `auto` | — | — | instruct if given, else zero_shot if transcript, else cross_lingual |

The old Qwen3-TTS server (`backend/legacy_qwen3_tts_server.py`) is kept for reference only:
it dropped the emotion prompt on the floor and used x-vector-only cloning.

## Prerequisites

- Node 18+ (`nvm use 20` works)
- `ffmpeg` / `ffprobe` on PATH
- A Python environment with the CUDA torch stack and CosyVoice's dependencies, plus a
  vendored [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) checkout. `backend/run.sh`
  looks for them at `.venv/bin/python` and `models/CosyVoice` inside this repo; point
  `STUDIO_PYTHON` / `STUDIO_COSYVOICE_REPO` elsewhere (e.g. in the git-ignored
  `scripts/local-env.sh`, see `scripts/local-env.example.sh`) to reuse an existing install.
  After cloning or pulling the CosyVoice checkout, apply the small compatibility patch with
  `bash scripts/patch-cosyvoice.sh`.
- Default model: `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` (~3.3 GiB VRAM, downloaded on first
  start). `FunAudioLLM/CosyVoice2-0.5B` also works: set
  `STUDIO_TTS_MODEL=FunAudioLLM/CosyVoice2-0.5B`.

Override with `STUDIO_PYTHON`, `STUDIO_COSYVOICE_REPO`, `STUDIO_TTS_MODEL`, `STUDIO_TTS_PORT`.
Every arena round records the model that made it; `node scripts/backfill-arena.mjs` stamps
category and model onto rounds created before those fields existed.

## Run

```bash
bash backend/run.sh              # CosyVoice3 backend on 127.0.0.1:8010 (internal; the browser never talks to it)
npm install && npm run dev       # Next.js on https://localhost:3010
```

(The default ports are 8010 for the backend and 3010 for the app; change them with
`STUDIO_TTS_PORT` and `next dev --port`.)

The app serves **HTTPS** with the self-signed certificate in `certs/` (SANs: localhost only
in the tracked `certs/openssl.cnf`) because the browser only exposes the microphone on a
secure origin. Accept the certificate warning once. `npm run dev:http` serves plain HTTP,
where recording only works from `localhost`. To reach the dev server from another machine,
list its hostnames/IPs in `STUDIO_DEV_ORIGINS` in a git-ignored `.env.local` (picked up by
`allowedDevOrigins` in next.config.ts, otherwise the page never hydrates) and regenerate the
cert with your SANs in a git-ignored `certs/openssl.local.cnf`:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout certs/dev-key.pem -out certs/dev-cert.pem -config certs/openssl.local.cnf
```

Import an already-prepared reference clip as a profile (defaults read
`datasets/voice-reference/processed/{prompt.wav,prompt.txt}`, or pass paths explicitly):

```bash
bash scripts/import-reference.sh <prompt.wav> <prompt.txt>
```

## Feeding a digital human

`GET /api/arena/export/digital-human` returns, per profile, the prompt wav path, its
transcript, and the top instructions by Elo. A downstream app that accepts an `instruct`
field next to the synthesis text can use the winning strings directly. Sharing the same
model weights and (via the import script) the same reference clip between both apps keeps
what wins in the arena sounding the same downstream.

## Layout

```
backend/server.py        FastAPI: /v1/tts, /v1/prepare, /health, /v1/load, /v1/unload
backend/postprocess.py   lead-breath trim
backend/run.sh           starts the backend (venv/checkout via STUDIO_PYTHON / STUDIO_COSYVOICE_REPO)
scripts/import-reference.sh
app/api/tts/*            profiles (multipart create, PUT edit), generate, health
app/api/arena/*          rounds, random (sampler), bank, votes, stats?model=, export, export/digital-human
lib/arena-bank.ts        line bank + balanced sampler
lib/arena-server.ts      shared round builder (records the backend model)
scripts/backfill-arena.mjs
app/api/presets          styles/voice-presets.json
app/arena, components/Arena*.tsx
lib/types.ts             the shared contract
lib/arena.ts             Elo / win-rate / preference pairs
data/                    voice-profiles.json, arena-rounds.json, arena-votes.jsonl (ignored)
public/audio/            uploads/, generated/, arena/ (ignored)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_ENDPOINT` | `http://127.0.0.1:8010` | Backend base URL for the Next.js routes |
| `STUDIO_PYTHON` | `./.venv/bin/python` | Interpreter for the backend |
| `STUDIO_COSYVOICE_REPO` | `./models/CosyVoice` | CosyVoice checkout |
| `STUDIO_TTS_MODEL` | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` | HF model id (`FunAudioLLM/CosyVoice2-0.5B` also works) |
| `STUDIO_TTS_PORT` | `8010` | Backend port |
| `STUDIO_WHISPER_MODEL` | `medium` | faster-whisper size for QC and prompt transcripts (CPU, int8, loaded once) |
| `STUDIO_TTS_PRELOAD` | `1` | Load the model at startup (`0` = on first request) |

## Responsible use

Clone only your own voice, or a voice you have explicit consent to use. Reference
recordings, synthesized audio, votes and fine-tuned checkpoints are personal data: they
live in git-ignored directories (`data/`, `datasets/`, `models/`, `exports/`,
`public/audio/`) and must never be committed, uploaded or logged. Exported bundles contain
the reference clips — treat them as private.

## License

Code: MIT (see [LICENSE](LICENSE)). Third-party components keep their own licenses:

- CosyVoice (vendored checkout; weights `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`,
  `FunAudioLLM/CosyVoice2-0.5B`): Apache-2.0, see the FunAudioLLM repository and model cards.
- CMU ARCTIC prompt list (`content/prompts/cmuarctic.data`): distributed by CMU/festvox for
  free use; cite Kominek & Black (2004).
- faster-whisper / CTranslate2: MIT. Whisper weights: MIT (OpenAI).
