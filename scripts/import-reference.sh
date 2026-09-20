#!/usr/bin/env bash
# Create a voice profile from an already-prepared prompt clip and its transcript. The clip
# is only converted (mono, 24 kHz), never re-denoised.
#
#   bash scripts/import-reference.sh <prompt.wav> <prompt.txt> [name] [language zh|en|auto]
#
# Defaults: datasets/voice-reference/processed/{prompt.wav,prompt.txt} in this repo
# (datasets/ is git-ignored), name "Owner (imported reference)", auto language.
# The studio must be running (npm run dev, https on port 3010) together with backend/run.sh.
# Pass STUDIO_URL=http://... if you run the dev server without TLS.
set -euo pipefail
cd "$(dirname "$0")/.."
STUDIO="${STUDIO_URL:-https://localhost:3010}"
WAV="${1:-$PWD/datasets/voice-reference/processed/prompt.wav}"
TXT="${2:-$PWD/datasets/voice-reference/processed/prompt.txt}"
NAME="${3:-Owner (imported reference)}"
LANG_="${4:-auto}"

[ -f "$WAV" ] || { echo "no prompt wav at $WAV" >&2; exit 1; }
[ -f "$TXT" ] || { echo "no transcript at $TXT" >&2; exit 1; }

# The clip is ingested as a take of a new neutral profile and judged by the same QC as any
# recording (level, noise, room reverb, intelligibility); the verdict is printed. A rejected
# clip leaves an empty profile behind, which is honest: the model must not clone from it.
[ "$LANG_" = "auto" ] && LANG_=en
curl -sSk -f -X POST "$STUDIO/api/tts/profiles" \
  -F "name=$NAME" \
  -F "description=Imported from $WAV" \
  -F "language=$LANG_" \
  -F "emotion=neutral" \
  -F "transcript=$(cat "$TXT")" \
  -F "audio=@$WAV;type=audio/wav" | python3 -c '
import json, sys
p = json.load(sys.stdin)
t = p.get("take")
print(json.dumps({"profile": p.get("id"), "name": p.get("name"), "verdict": t and t["verdict"], "reasons": t and t["reasons"], "prompt": p.get("promptAudioPath")}, indent=2, ensure_ascii=False))
'
