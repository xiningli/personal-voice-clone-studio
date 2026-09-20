# Protocol: collect → evaluate → fine-tune a personal voice

This document is the methodology contract for the studio. Every page, API route and
backend module implements one step of it. Numbers in brackets are the defaults; all are
configurable and are written into every exported record so results are reproducible.

## 0. Principles

- **Blind, seeded, paired.** Every listening judgment compares candidates of the same text,
  same speaker prompt and same random seed, shown under shuffled labels. The only free
  variable in a round is the thing being tested (instruction, model, or checkpoint).
- **Sampled, not typed.** Test sentences and candidate instructions are drawn by the
  sampler from fixed pools with inverse-frequency weighting, so the rater does not choose
  the sentence that flatters one condition.
- **Record everything.** Model id, checkpoint hash, seed, prompt path, instruction, blind
  label, rater notes, objective metrics. Nothing is derived after the fact that cannot be
  recomputed from the record.
- **Private by default.** Recordings, prompts, synthesized audio and votes live in ignored
  directories. The product is open source; the speaker's data is not.

## 1. Corpus collection (`/voices`, inside Voice Profiles)

**Where.** Collection happens inside Voice Profiles: one profile per emotion. Creating a
profile opens a recording session; every take is recorded for that profile in that emotion and
judged on the spot. A profile's cloning prompt is derived from its accepted takes (the single best
5–15 s take by reverb tail then SNR, else the best takes concatenated with 250 ms gaps to ≥ 8 s),
so nothing the model clones from has bypassed QC. "Upload a clip" goes through the same QC.

**Prompt sets.** Neutral profiles read CMU ARCTIC (`content/prompts/cmuarctic.data`, 1132
sentences, phonetically balanced English, freely redistributable; Kominek & Black 2004) in
ARCTIC order, so a partial corpus is still balanced. Every other emotion reads its **own bank**
of 120 English sentences whose wording carries that emotion
(`content/prompts/emotions/<emotion>.txt`; 8–20 words, mean ≈ 12), because a sentence that
contradicts the tag ("For the twentieth time that evening…" read cheerfully) produces
unnatural takes and a mislabelled corpus. A session shows the emotion's reading script
first, then its bank, skipping sentences already accepted for that emotion.

**Sizing.** Reading time is modelled as 0.38 s per word + 0.6 s per sentence (≈ 150 wpm).
With a 60 % acceptance rate (observed on this machine's first sessions) a 5-minute emotion
target needs ≈ 100 recordings of 12-word sentences, so each bank holds 120 sentences for a
20 % margin; the 10-minute neutral SFT minimum needs ≈ 310 ARCTIC sentences and the
30-minute recommendation ≈ 940, both inside ARCTIC's 1132. `GET /api/corpus/bank` reports,
per profile, the sentences left, the speech they would yield, the profile's own acceptance
rate and mean take length, and the number of recordings still needed; the session shows
the same line under the progress bar.

**Take = one sentence, one recording.** Stored as mono 24 kHz 16-bit PCM under
`datasets/<speakerId>/wavs/<takeId>.wav`, with a record in `datasets/<speakerId>/takes.jsonl`.

**Quality control on every take** (backend `POST /v1/qc`), computed on the trimmed take:

| metric | how | accept when |
|---|---|---|
| duration | after leading/trailing silence trim | 1.0–30 s |
| peak level | dBFS | ≤ −1 dBFS and clipping ratio < 0.1 % |
| noise floor | RMS of the quietest 10 % of 10 ms frames, dB | ≤ −45 dB |
| SNR | speech level (mean of the loudest 50 % of 10 ms frames) − noise floor; the noise floor is the median frame level of the lead-in and tail the trim removed (≥ 200 ms of real silence), falling back to the quietest 10 % of frames | ≥ 30 dB → **clean**; 24–30 dB → **borderline**; < 24 dB → reject |
| reverb tail | reference = 95th-percentile 10 ms frame level; a word offset is where the level drops 12 dB under it and stays there 160 ms; median energy 60–160 ms after each offset (the take is padded with 200 ms of silence so the last word counts) relative to the reference, dB. Level-independent by construction. | ≤ −25 dB → **clean**; −25…−20 dB → accepted as **borderline**; > −20 dB → reject |
| intelligibility | word error rate of the faster-whisper transcript vs the prompt, both passed through Whisper's English text normaliser (contractions, numerals, spelling variants) | reject only when WER > 0.10 **and** ≥ 3 words differ; a WER over 0.10 from 1–2 words is accepted with a warning |

A take that fails is kept on disk with `verdict: "reject"` and the failing metrics, so the
rater sees why and re-records. Only accepted takes enter the corpus. Accepted takes carry a
`quality` tier: **clean** (all limits met) or **borderline** (the reverb tail is in the
−25…−20 dB band and/or the SNR is in the 24–30 dB band; everything else met). Borderline takes are unaltered; they count toward the zero-shot prompt and
the readiness totals, are reported separately, and are excluded from training unless the
job opts in (`include_borderline`), which the model card then records.

**Why no automatic dereverberation.** Two candidates were evaluated on this machine's own
recordings before choosing the tier rule: SRMR (Falk et al. 2010) did not separate a
reverberant browser take from a dry synthetic one (6.5 vs 5.8), so it is not used as a
gate; single-channel WPE (Nakatani et al. 2010, 10–60 taps) lowered the tail of a roomy
synthetic clip by up to 7 dB but left a real reverberant take unchanged and made a dry phone
clip measurably worse (−38 → −26 dB), so it is not applied. Enhancement, if ever added,
must be an opt-in job whose output is compared against the raw take in the arena.

**Readiness** (`GET /api/corpus/stats`): accepted minutes overall and per emotion,
sentence count, distinct-word count, and the thresholds below.

| use | needs |
|---|---|
| better zero-shot profile | ≥ 1 min clean, any emotion |
| speaker-adaptation SFT | ≥ 10 min clean neutral (30 min recommended) |
| emotion-conditioned SFT | ≥ 5 min per emotion tag |
| DPO on preferences | ≥ 200 decided pairs from the same base checkpoint |

**Export** (`GET /api/corpus/export`): LJSpeech-layout `metadata.csv` (`id|text|normalized`),
`wavs/`, and a generated `DATASET_CARD.md` (speaker id, date range, minutes, QC thresholds,
emotion distribution, consent statement, license placeholder).

## 2. Subjective evaluation (`/arena`)

**Design.** Two-alternative forced choice with a "no preference" option, plus per-candidate
absolute ratings on three 5-point scales (ITU-T P.800 ACR wording for naturalness; SMOS
wording for similarity; emotion match). Ratings are optional; the choice is required.

**Trials.** The sampler emits three trial types, tagged on the round:

- `test` [55 %]: fresh line, two instructions drawn by inverse-frequency weighting, one seed.
  The choice is an instruction preference and feeds the Bradley-Terry ranking.
- `seed` [25 %]: fresh line, one instruction, two seeds. The choice is a preference between
  two samples of the same prompt; these pairs, and only these, are DPO training data
  (§3 stage B). They never enter the instruction ranking.
- `repeat` [15 %]: a previously voted pair re-served with fresh labels and a fresh shuffle.
  Agreement with the earlier vote is the rater's test-retest reliability.
- `anchor` [5 %]: one candidate is a real recording of the speaker (an accepted take of the
  same sentence) against a synthesized version. Anchors give the similarity scale a
  ceiling and detect a rater who is not listening.
- `duel` [on request]: two checkpoints on the same line, the same instruction (drawn by
  inverse frequency over previous duels; the pure clone is allowed) and the same seed, so
  the checkpoint is the only variable. The backend swaps models per candidate and is
  restored afterwards. Duel rounds carry `model: "duel"` and `models: [a, b]`, and each
  candidate records the model that made it; they are never mixed into the per-instruction
  Bradley-Terry table. Reported per unordered model pair as A's pairwise win rate with a
  Wilson 95 % interval, plus mean ratings, WER and speaker similarity per model.

**Ranking.** Bradley-Terry strengths fitted by maximum likelihood on decided `test` votes,
with 95 % bootstrap confidence intervals [1000 resamples]. Elo is kept for a live view only.
Rounds from different backend models or checkpoints are never pooled; `model` is a hard
partition key. Reported per instruction: BT score, CI, wins/losses, mean ratings, and the
objective metrics below averaged over its candidates.

**Objective metrics per candidate** (backend `POST /v1/metrics`, computed right after
generation, stored on the candidate):

- `wer`: faster-whisper transcript vs the line (intelligibility / hallucination).
- `speaker_similarity`: cosine between CAM++ x-vectors (the same `campplus.onnx` CosyVoice
  conditions on) of the candidate and the profile prompt. This is the SECS number used in
  TTS papers; report it as a sanity check, not as a substitute for human similarity.
- `duration`, `reverb_tail` (same estimator as QC; on synthesized audio it exposes the roomy, doubled sound some instruct-mode outputs have).

**Export.** `preference-pairs.jsonl`: one line per decided pair with `category`, `model`,
`trial`, `text`, both sides (`candidateId`, `label`, `instruct`, `speed`, `seed`,
`audioPath`, `note`, `metrics`), ratings, timestamp. Repeat trials export with
`trial: "repeat"` and are excluded from BT by default.

## 3. Fine-tuning (`/train`)

Two stages, both on the CosyVoice3 recipe in the vendored checkout, run as background jobs
by `backend/train.py` with logs streamed to the page.

**Stage A — speaker adaptation (SFT).** Input: accepted takes. Pipeline:
`wav.scp/text/utt2spk/spk2utt` (+ `instruct` = `You are a helpful assistant.<|endofprompt|>`)
→ CAM++ embeddings → speech tokens (`speech_tokenizer_v3.onnx`) → parquet →
`cosyvoice/bin/train.py --model llm` from `llm.pt` (torch_ddp, AMP, 1 GPU) → average the
best-N checkpoints → assemble a full model directory under `models/<name>/` (symlinks to the
base for everything except `llm.pt`). The flow model is optionally fine-tuned the same way
when ≥ 30 min are available. Held-out: 5 % of takes by sentence id, fixed seed.

**Stage B — preference optimization (DPO).** Input: decided `seed`-trial pairs made by the
stage-A checkpoint (same text and instruction on both sides; the instruction is written
into the training prompt in the inference format). For each pair, `speech_token` = tokens of the chosen wav, `reject_speech_token` =
tokens of the rejected wav, `text` = the line, embedding = the profile prompt's x-vector;
`make_parquet_list.py --dpo`, then `train.py --dpo --ref_model <stage-A llm.pt>`
(β = 0.01 as shipped). Requires ≥ 200 pairs; the page refuses below that.

**Registration.** A finished job appears in `GET /v1/models`; `POST /v1/models/select`
hot-swaps the backend. Every arena round made afterwards carries the new model id, so the
checkpoint is evaluated with exactly the protocol in §2 against the base model.

## 4. Reporting

`GET /api/report` renders the current state as Markdown: corpus card, evaluation table
(BT ± CI per instruction per model), rater reliability (repeat agreement, anchor accuracy),
objective metrics, training runs (config hash, steps, held-out loss). This is what a paper
appendix or a model card needs.

## 5. Export (`/export`)

A fine-tuned checkpoint leaves the studio as a bundle: `model/` with every base file
copied (no symlinks into this machine's caches), `profiles/` with one reference clip and
transcript per profile, `serve/` with this backend, a serving-only requirements file,
`install.sh` (uv, Python 3.12, torch for the driver's CUDA, the CosyVoice checkout),
`run.sh`, a systemd user unit and a README, and `manifest.json` naming the checkpoint, its
training config and the profiles. `POST /v1/export` builds it as a job and, when asked,
pushes it with rsync over SSH; the remote install is the bundle's own scripts, printed by
the job, so what runs on the server is inspectable and re-runnable by hand. The exported
service answers `GET /v1/profiles` with the clips and their paths on that machine, so a
client needs only the service URL. The service has no authentication and is meant for a
private network; the bundle is personal voice data and is never published.

## References

- Kominek, J., Black, A. W. (2004). The CMU Arctic speech databases. SSW5.
- ITU-T P.800 (1996). Methods for subjective determination of transmission quality.
- ITU-T P.808 (2018). Subjective evaluation of speech quality with a crowdsourcing approach.
- Bradley, R. A., Terry, M. E. (1952). Rank analysis of incomplete block designs. Biometrika.
- Rafailov, R. et al. (2023). Direct Preference Optimization. NeurIPS.
- Du, Z. et al. (2024/2025). CosyVoice 2 / CosyVoice 3. arXiv:2412.10117, 2505.17589.
- Wang, H. et al. (2023). CAM++: A fast and efficient network for speaker verification. Interspeech.
