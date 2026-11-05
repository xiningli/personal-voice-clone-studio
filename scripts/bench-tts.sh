#!/usr/bin/env bash
# Run backend/bench_tts.py under each acceleration setting, one process per setting.
#   scripts/bench-tts.sh <model dir> <reference wav> [out.jsonl]
# Uses STUDIO_PYTHON / STUDIO_COSYVOICE_REPO like backend/run.sh. The first TensorRT run
# builds the engine for this GPU (minutes); the first vLLM run exports the LM into <model dir>/vllm.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f scripts/local-env.sh ] && . scripts/local-env.sh
PY="${STUDIO_PYTHON:-.venv/bin/python}"
MODEL="$1"; PROMPT="$2"; OUT="${3:-outputs/bench-tts.jsonl}"
export STUDIO_TTS_MODEL="$MODEL" STUDIO_COSYVOICE_REPO="${STUDIO_COSYVOICE_REPO:-models/CosyVoice}"
for cfg in "base:0:0" "trt:1:0" "vllm:0:1" "trt+vllm:1:1"; do
  IFS=: read -r label trt vllm <<<"$cfg"
  echo "=== $label ==="
  STUDIO_TTS_TRT=$trt STUDIO_TTS_VLLM=$vllm "$PY" backend/bench_tts.py --label "$label" --prompt "$PROMPT" --out "$OUT" \
    || echo "!!! $label failed"
done
