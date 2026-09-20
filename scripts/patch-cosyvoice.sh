#!/usr/bin/env bash
# Re-apply the studio's small compatibility patch to the vendored CosyVoice checkout after
# `git pull` there. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${STUDIO_COSYVOICE_REPO:-$PWD/models/CosyVoice}"
F="$REPO/cosyvoice/utils/train_utils.py"
if grep -q "studio patch" "$F"; then echo "already patched: $F"; exit 0; fi
python3 - "$F" <<'PY'
import sys, pathlib
p=pathlib.Path(sys.argv[1]); s=p.read_text()
old='''    if info_dict["batch_idx"] != 0:
        # we try to join all rank in both ddp and deepspeed mode, in case different rank has different lr
        try:
            dist.monitored_barrier(group=group_join,
                                   timeout=group_join.options._timeout)
            return False'''
new='''    if world_size == 1:
        # Single process: nothing to join. torch >= 2.6 also dropped ProcessGroup.options,
        # which the barrier below relied on (studio patch, see backend/train.py).
        return False
    if info_dict["batch_idx"] != 0:
        # we try to join all rank in both ddp and deepspeed mode, in case different rank has different lr
        try:
            timeout = getattr(getattr(group_join, "options", None), "_timeout", None) or datetime.timedelta(seconds=1800)
            dist.monitored_barrier(group=group_join, timeout=timeout)
            return False'''
assert old in s, "cosyvoice_join looks different; patch by hand"
p.write_text(s.replace(old,new,1)); print("patched", p)
PY
