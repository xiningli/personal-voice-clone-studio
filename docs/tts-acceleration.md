# CosyVoice3 acceleration and streaming — measurements (2026-11-06)

Branch `tts-acceleration`. Code: `backend/server.py` (opt-in `STUDIO_TTS_TRT`, `STUDIO_TTS_VLLM`,
`STUDIO_TTS_JIT`, `STUDIO_TTS_STREAM_POLL_S`, new `POST /v1/tts/stream`), `backend/bench_tts.py`,
`scripts/bench-tts.sh`. Raw rows: `docs/bench-2026-11-06/bench-tts.jsonl` (108 syntheses).

## Setup

- RTX 5090 32 GB (AutoDL), driver 595.71, torch 2.8.0+cu128, vLLM 0.11.0, TensorRT 10.13.3,
  transformers 4.57.1, CosyVoice at 074ca6d (same commit as the local checkout).
- Model: base `Fun-CosyVoice3-0.5B-2512`. owner-sft-v2 differs only in `llm.pt` (train.py trains
  the LLM stage; flow and ONNX are symlinks to the base), so speed transfers; quality was not
  checked on owner-sft-v2.
- Reference: CosyVoice's `asset/zero_shot_prompt.wav`; instruct mode, "Please speak in a warm and
  friendly tone.", seed 7, speed 1.0. Two warm-up runs, then the median of 3 per cell.
- Not measured on the RTX 5070 Ti (it was serving the live site).

## Results (seconds)

| config | short 1.6 s audio | medium ~4.4 s | long ~10 s | long, stream first chunk | LM tokens/s |
|---|---|---|---|---|---|
| base (fp16 PyTorch) | 0.79–0.82 | 1.76–1.85 | 3.67–3.70 | 2.15 (1.18 with the hop reset) | 67–76 |
| TensorRT flow | 0.73 | 1.72 | 3.61 | 1.80 | — |
| vLLM LM | 0.53 | 0.59 | 1.07 | 0.92 | — |
| TensorRT + vLLM | 0.22 | 0.41 | 0.89 | 0.59 | — |
| TensorRT + vLLM + stream fix | 0.25 | 0.42 | 0.91 | **0.44** | 329–374 |

Stream first chunk for the fastest config: short 0.225 s, medium 0.292 s, long 0.442 s.

Where the time goes (whole sentence, long): base — LM 3.43 s, flow + HiFT 0.23 s; TensorRT + vLLM —
LM 0.77 s, flow + HiFT 0.15 s. The bottleneck is autoregressive speech-token generation, not GPU
compute; vLLM raises it about 5x (67–76 → 329–374 tokens/s). TensorRT alone barely moves the total
because the flow is a small share until the LM is fast.

Quality spot check: Whisper small transcribed each sentence of `base-q` and `trt+vllm+streamfix`
with WER 0.00 (one take per sentence; speaker similarity not measured). With vLLM the same seed
gives different durations (medium 4.52 → 4.20–4.36 s): sampling takes another path.

## Two upstream streaming issues (worked around in server.py, CosyVoice untouched)

1. `CosyVoice2/3Model.tts` doubles `self.token_hop_len` after every streamed chunk (25 → 50 → 100)
   and never resets it, so after the first streamed call every later call waits for 100 tokens
   (about 4 s of audio) before its first chunk. The studio restores it to 25 before each call.
2. The stream loop polls with `time.sleep(0.1)`; `STUDIO_TTS_STREAM_POLL_S=0.02` shortens it.

The first chunk still waits for `token_hop_len` (25) plus padding to align the flow prompt and the
flow's lookahead; 25 matches the flow's training chunk size, so it was not lowered.

## Costs of turning acceleration on

- TensorRT: first load builds `flow.decoder.estimator.fp16.mygpu.plan` (load 100 s instead of 15 s);
  the plan is GPU-specific, and server.py rebuilds it when the recorded GPU differs. Later loads 33 s.
- vLLM: exports the LM into `<model_dir>/vllm` and reserves 20% of the card (CosyVoice's
  `gpu_memory_utilization=0.2`; on a 16 GB card about 3.2 GB), which matters next to SDXL / ASR on
  one GPU. torch's peak-memory counter does not include vLLM's pool.
- Streaming needs speed 1.0 (CosyVoice changes speed by resampling the whole mel).

## Not done yet

- The same benchmark on the RTX 5070 Ti, including whether vLLM's reservation fits beside the
  site's other models.
- A listening check and speaker similarity on owner-sft-v2.
