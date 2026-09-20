#!/usr/bin/env bash
# Start the CosyVoice backend on 127.0.0.1:8010 (Fun-CosyVoice3-0.5B by default; STUDIO_TTS_MODEL overrides).
#
# Expects a Python environment with the CUDA torch stack plus CosyVoice's deps, and a
# vendored CosyVoice checkout. Defaults assume both live in this repo (.venv/ and
# models/CosyVoice); override with STUDIO_PYTHON / STUDIO_COSYVOICE_REPO, or put them in
# scripts/local-env.sh (git-ignored — copy scripts/local-env.example.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# shellcheck disable=SC1091
[ -f scripts/local-env.sh ] && . scripts/local-env.sh

export STUDIO_PYTHON="${STUDIO_PYTHON:-$REPO_ROOT/.venv/bin/python}"
export STUDIO_COSYVOICE_REPO="${STUDIO_COSYVOICE_REPO:-$REPO_ROOT/models/CosyVoice}"
export STUDIO_TTS_PORT="${STUDIO_TTS_PORT:-8010}"

if [ ! -x "$STUDIO_PYTHON" ]; then
  echo "no python at $STUDIO_PYTHON — set STUDIO_PYTHON in scripts/local-env.sh" >&2
  exit 1
fi
if [ ! -d "$STUDIO_COSYVOICE_REPO/cosyvoice" ]; then
  echo "no CosyVoice checkout at $STUDIO_COSYVOICE_REPO — set STUDIO_COSYVOICE_REPO in scripts/local-env.sh" >&2
  exit 1
fi

exec "$STUDIO_PYTHON" backend/server.py
