#!/usr/bin/env bash
# Dry-run of the stage-A pipeline on a tiny corpus built from the existing profile prompts.
# Stages a-d run for real on CPU (Kaldi dir, CAM++ embeddings, speech tokens, parquet);
# torchrun is printed, not executed (STUDIO_TRAIN_DRY_RUN=1).
#
#   bash scripts/train-smoke.sh            # uses a throwaway backend on port 8013
#
# Never touches the live backend on 8010.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f scripts/local-env.sh ] && . scripts/local-env.sh
PY="${STUDIO_PYTHON:-$PWD/.venv/bin/python}"
PORT="${SMOKE_PORT:-8013}"
NAME="smoke-$(date +%H%M%S)"

echo "== building datasets/smoke from profile prompts"
rm -rf datasets/smoke; mkdir -p datasets/smoke/wavs
python3 - <<'PYX'
import json, shutil, pathlib, wave
root = pathlib.Path(".")
profiles = json.load(open(root / "data" / "voice-profiles.json"))
out = root / "datasets" / "smoke"
n = 0
with open(out / "takes.jsonl", "w") as f:
    for i, p in enumerate(profiles):
        if not p.get("promptAudioPath") or not p.get("promptText"):
            continue
        src = root / "public" / p["promptAudioPath"].lstrip("/")
        if not src.is_file():
            continue
        dst = out / "wavs" / f"take{i:03d}.wav"
        shutil.copy2(src, dst)
        with wave.open(str(dst)) as w:
            dur = w.getnframes() / w.getframerate()
        take = {
            "id": f"take{i:03d}", "speakerId": "smoke", "sessionId": "smoke", "promptId": f"prompt{i:03d}",
            "text": p["promptText"], "emotion": p.get("emotion") or "neutral", "language": "en",
            "audioPath": str(dst.relative_to(root)), "sourcePath": str(dst.relative_to(root)),
            "metrics": {"duration": dur, "peakDbfs": -3, "clippingRatio": 0, "noiseFloorDb": -50, "snrDb": 40,
                        "reverbTailDb": -30, "wer": 0, "transcript": p["promptText"]},
            "verdict": "accept", "reasons": [], "createdAt": p.get("createdAt", ""),
        }
        f.write(json.dumps(take) + "\n"); n += 1
print(f"{n} takes written")
PYX

echo "== starting throwaway backend on :$PORT (no model preload, dry-run training)"
STUDIO_TTS_PRELOAD=0 STUDIO_TTS_PORT=$PORT STUDIO_TRAIN_DRY_RUN=1 "$PY" backend/server.py > "datasets/smoke/server.log" 2>&1 &
SPID=$!
trap 'kill $SPID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -s "http://127.0.0.1:$PORT/health" | python3 -c "import sys,json; h=json.load(sys.stdin); print('health:', h['model'], 'ready=', h['ready'])"

echo "== POST /v1/train/sft"
JOB=$(curl -sf -X POST "http://127.0.0.1:$PORT/v1/train/sft" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"speaker_id\":\"smoke\",\"dataset_dir\":\"$PWD/datasets/smoke\",\"epochs\":2,\"heldout_fraction\":0.2}")
ID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "job $ID"
for i in $(seq 1 120); do
  S=$(curl -s "http://127.0.0.1:$PORT/v1/train/jobs/$ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  case "$S" in done|failed|cancelled) break;; esac
  sleep 2
done
echo "== final status: $S"
curl -s "http://127.0.0.1:$PORT/v1/train/jobs/$ID" | python3 -c "
import sys,json; j=json.load(sys.stdin)
print('error:', j.get('error')); print('data:', j.get('dataSummary'))
print('--- log tail ---'); print('\n'.join(j['logTail'][-12:]))"
echo "== parquet files"; find "models/$NAME/work/data" -name '*.tar' -o -name 'data.list' | sort
echo "== GET /v1/models"; curl -s "http://127.0.0.1:$PORT/v1/models" | python3 -m json.tool | head -30
[ "$S" = done ]
