"""Export a fine-tuned checkpoint as a self-contained voice service (docs/protocol.md §5).

A bundle is a directory the studio can hand to another machine:

    exports/<name>/
      manifest.json            what is inside, and where it came from
      model/                   the checkpoint with every base file copied (no symlinks)
      profiles/                one reference clip per profile + profiles.json (transcripts)
      serve/                   this backend, a requirements file, install.sh, run.sh, a
                               systemd user unit and a README: everything a server needs

`POST /v1/export` builds one as a background job and, when asked, pushes it to a host with
rsync over SSH. The remote install is left to the bundle's own scripts, printed by the job,
so what runs there is inspectable and re-runnable by hand.

Routes (mounted by server.py):
    GET  /v1/export/bundles           bundles under exports/
    POST /v1/export                   {model_id, name?, profile_ids?, push?: {host, path}} -> job
    GET  /v1/export/jobs/{id}         job status and log tail
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
ROOT = Path(__file__).resolve().parent.parent
EXPORTS_DIR = Path(os.environ.get("STUDIO_EXPORTS_DIR", ROOT / "exports"))
PROFILES_FILE = ROOT / "data" / "voice-profiles.json"
# Training leftovers that a serving machine does not need.
SKIP_IN_MODEL = {"work", "train.log", "__pycache__"}
SERVE_FILES = ("server.py", "postprocess.py", "qc.py", "metrics.py", "train.py", "train_tools.py", "export.py")

REQUIREMENTS_SERVE = """fastapi==0.139.0
uvicorn==0.44.0
pydantic==2.12.4
numpy==2.3.5
huggingface-hub==0.36.2
transformers==4.57.3
tokenizers==0.22.2
safetensors==0.7.0
diffusers==0.37.1
onnxruntime==1.24.4
librosa==0.11.0
soundfile==0.13.1
omegaconf==2.3.0
HyperPyYAML==1.2.3
conformer==0.3.2
x-transformers==2.28.4
inflect==7.5.0
modelscope==1.40.0
openai-whisper==20250625
wetext==0.1.8
Unidecode==1.4.0
tiktoken==0.14.0
einops==0.8.2
scipy==1.16.3
regex==2026.4.4
pyyaml==6.0.3
torchcodec==0.16.0
hydra-core==1.3.2
lightning==2.6.6
rootutils==1.0.7
gdown==6.2.0
pyworld==0.3.5
wget==3.2
rich==14.2.0
matplotlib==3.10.6
pyarrow==21.0.0
setuptools==80.9.0
phonemizer
"""

INSTALL_SH = """#!/usr/bin/env bash
# Install the exported voice service next to this script: a Python 3.12 venv through uv, torch
# for the CUDA of the driver on this machine (override TORCH_INDEX), the CosyVoice checkout the
# server imports, and the serving requirements. No sudo; nothing outside this directory except
# uv itself under ~/.local.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
uv python install 3.12
[ -x .venv/bin/python ] || uv venv .venv --python 3.12
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu130}"
# The same torch the studio validated; newer wheels changed the CPU output audibly.
uv pip install --python .venv/bin/python torch==2.11.0 torchaudio==2.11.0 --index-url "$TORCH_INDEX"
uv pip install --python .venv/bin/python -r serve/requirements-serve.txt
if [ ! -d cosyvoice-repo/third_party/Matcha-TTS/matcha ]; then
  [ -d cosyvoice-repo ] || git clone --depth 1 https://github.com/FunAudioLLM/CosyVoice cosyvoice-repo
  git -C cosyvoice-repo submodule update --init --depth 1 third_party/Matcha-TTS
fi
.venv/bin/python - <<'PY'
import sys
sys.path[:0] = ["cosyvoice-repo", "cosyvoice-repo/third_party/Matcha-TTS"]
import torch
from cosyvoice.cli.cosyvoice import CosyVoice3  # noqa: F401
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
PY
echo "installed under $ROOT; start with: bash serve/run.sh   (or install the systemd unit, see serve/README.md)"
"""

RUN_SH = """#!/usr/bin/env bash
# Run the exported voice service. Listens on every interface (STUDIO_TTS_HOST) so other
# machines can use it; put it behind a firewall or a tunnel, it has no authentication.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export STUDIO_COSYVOICE_REPO="$ROOT/cosyvoice-repo"
export STUDIO_TTS_MODEL="$ROOT/model"
export STUDIO_MODELS_DIR="$ROOT/models"
export STUDIO_PROFILES_FILE="$ROOT/profiles/profiles.json"
export STUDIO_TTS_HOST="${STUDIO_TTS_HOST:-0.0.0.0}"
export STUDIO_TTS_PORT="${STUDIO_TTS_PORT:-8010}"
export STUDIO_TTS_PRELOAD="${STUDIO_TTS_PRELOAD:-1}"
# STUDIO_FORCE_CPU=1 hides the GPU: for a card too small for inference (the model alone
# peaks at 3.3 GiB; a 4 GB card runs out mid-sentence). CPU synthesis is slow but complete.
if [ "${STUDIO_FORCE_CPU:-0}" = "1" ]; then export CUDA_VISIBLE_DEVICES=""; fi
exec .venv/bin/python serve/server.py
"""

SERVICE_UNIT = """[Unit]
Description=Personal Voice Clone Studio - exported voice service ({name})
After=network-online.target

[Service]
WorkingDirectory={root}
# Set STUDIO_FORCE_CPU=1 here when the GPU is too small for the model (needs >= 6 GB).
Environment=STUDIO_FORCE_CPU=0
ExecStart=/usr/bin/env bash {root}/serve/run.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"""

README = """# {name}

A voice service exported from Personal Voice Clone Studio on {created}: the fine-tuned
checkpoint `{model}` (stage {stage}, base {base}) with {n_profiles} reference profile(s).

## Install and run

```bash
bash serve/install.sh          # uv, Python 3.12, torch ({torch_note}), CosyVoice, requirements
bash serve/run.sh              # http://0.0.0.0:8010  (STUDIO_TTS_PORT / STUDIO_TTS_HOST to change)
```

A GPU needs about 4 GB free for the model plus room for inference (6 GB or more in
practice). On a smaller card set `STUDIO_FORCE_CPU=1` (in the unit below, or in the shell
before `run.sh`): synthesis then runs on every CPU core, at roughly 3-4x real time on a
12-thread workstation, which suits cached, offline use such as the motion arena but not a
live conversation.

## Keep it running (systemd, user session)

```bash
mkdir -p ~/.config/systemd/user
cp serve/voice-service.service ~/.config/systemd/user/voice-service.service
systemctl --user daemon-reload
systemctl --user enable --now voice-service
loginctl enable-linger $USER    # keeps user services alive without a login session
journalctl --user -u voice-service -f
```

## Use

```bash
curl -s http://<host>:8010/health
curl -s http://<host>:8010/v1/profiles           # reference clips on this machine, with paths
curl -s -X POST http://<host>:8010/v1/tts -H 'Content-Type: application/json' -d '{{
  "text": "Hello from the exported voice.", "reference_audio": "<wav from /v1/profiles>",
  "prompt_text": "<promptText from /v1/profiles>", "instruct": "Speak warmly.", "mode": "auto"}}' -o out.wav
```

The service has no authentication: keep it on a private network. Everything in this bundle
is the owner's personal voice data; do not publish it.
"""


class ExportRequest(BaseModel):
    model_id: str = Field(min_length=1)
    name: Optional[str] = None
    profile_ids: Optional[list[str]] = None
    push: Optional[dict] = None  # {"host": "user@host", "path": "~/voice-service"}


class ExportJob:
    def __init__(self, job_id: str, name: str, model_id: str, push: Optional[dict]) -> None:
        self.id = job_id
        self.name = name
        self.model_id = model_id
        self.push = push
        self.status = "queued"
        self.step = ""
        self.log: list[str] = []
        self.error: Optional[str] = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.finished_at: Optional[str] = None
        self.bundle_dir = EXPORTS_DIR / name
        self.bytes_copied = 0
        self.bytes_total = 0

    def say(self, line: str) -> None:
        self.log.append(f"{time.strftime('%H:%M:%S')} {line}")
        if len(self.log) > 400:
            del self.log[: len(self.log) - 400]

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "modelId": self.model_id, "status": self.status, "step": self.step,
            "error": self.error, "createdAt": self.created_at, "finishedAt": self.finished_at,
            "bundleDir": str(self.bundle_dir), "push": self.push, "bytesCopied": self.bytes_copied,
            "bytesTotal": self.bytes_total, "logTail": self.log[-60:],
        }


JOBS: dict[str, ExportJob] = {}
JOBS_LOCK = threading.Lock()


def _server():
    import server  # noqa: PLC0415  (the running module, aliased by server.py)

    return server


def _load_profiles() -> list[dict]:
    try:
        return json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _model_dir(model_id: str) -> Path:
    p = Path(model_id)
    if not (p.is_dir() and (p / "llm.pt").exists()):
        raise HTTPException(400, "model_id must be a fine-tuned checkpoint directory with llm.pt")
    return p


def _copy_tree(src: Path, dst: Path, job: ExportJob, skip: set[str]) -> None:
    """Copy with symlinks dereferenced, so the bundle stands alone; reports bytes as it goes."""
    for entry in sorted(src.iterdir()):
        if entry.name in skip:
            continue
        target = dst / entry.name
        real = entry.resolve()
        if real.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy_tree(real, target, job, set())
            continue
        size = real.stat().st_size
        if target.exists() and target.stat().st_size == size:
            job.bytes_copied += size
            continue
        shutil.copyfile(real, target)
        job.bytes_copied += size
        job.say(f"copied {entry.name} ({size / 1e6:.0f} MB)")


def _tree_size(src: Path, skip: set[str]) -> int:
    total = 0
    for entry in src.iterdir():
        if entry.name in skip:
            continue
        real = entry.resolve()
        total += _tree_size(real, set()) if real.is_dir() else real.stat().st_size
    return total


def _build(job: ExportJob, model_dir: Path, profiles: list[dict]) -> None:
    bundle = job.bundle_dir
    bundle.mkdir(parents=True, exist_ok=True)
    job.status, job.step = "copying", "model"
    job.bytes_total = _tree_size(model_dir, SKIP_IN_MODEL)
    job.say(f"model {model_dir.name}: {job.bytes_total / 1e9:.1f} GB to copy")
    (bundle / "model").mkdir(exist_ok=True)
    _copy_tree(model_dir, bundle / "model", job, SKIP_IN_MODEL)

    job.step = "profiles"
    pdir = bundle / "profiles"
    pdir.mkdir(exist_ok=True)
    exported = []
    for p in profiles:
        src = ROOT / "public" / str(p.get("promptAudioPath", "")).lstrip("/")
        if not src.is_file():
            job.say(f"profile {p.get('name')}: prompt wav missing, skipped")
            continue
        emotion = str(p.get("emotion") or "neutral")
        fname = f"{emotion}-{str(p.get('id'))[:8]}.wav"
        shutil.copyfile(src, pdir / fname)
        exported.append({
            "id": p.get("id"), "name": p.get("name"), "emotion": emotion, "language": p.get("language", "en"),
            "wav": f"profiles/{fname}", "promptText": p.get("promptText", ""), "durationSeconds": p.get("durationSeconds"),
        })
        job.say(f"profile {p.get('name')} ({emotion}) -> {fname}")
    (pdir / "profiles.json").write_text(json.dumps(exported, indent=2), encoding="utf-8")

    job.step = "serve"
    sdir = bundle / "serve"
    sdir.mkdir(exist_ok=True)
    here = Path(__file__).resolve().parent
    for f in SERVE_FILES:
        if (here / f).exists():
            shutil.copyfile(here / f, sdir / f)
    (sdir / "requirements-serve.txt").write_text(REQUIREMENTS_SERVE, encoding="utf-8")
    (sdir / "install.sh").write_text(INSTALL_SH, encoding="utf-8")
    (sdir / "run.sh").write_text(RUN_SH, encoding="utf-8")
    for f in ("install.sh", "run.sh"):
        os.chmod(sdir / f, 0o755)
    remote_root = _remote_root(job)
    (sdir / "voice-service.service").write_text(SERVICE_UNIT.format(name=job.name, root=remote_root), encoding="utf-8")
    try:
        meta = json.loads((model_dir / "meta.json").read_text())
    except (OSError, ValueError):
        meta = {}
    manifest = {
        "name": job.name, "createdAt": job.created_at,
        "model": {"name": model_dir.name, "stage": meta.get("stage"), "baseModel": meta.get("baseModel"), "createdAt": meta.get("createdAt"), "meta": meta},
        "profiles": exported, "serve": {"port": 8010, "run": "bash serve/run.sh"},
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (sdir / "README.md").write_text(README.format(
        name=job.name, created=job.created_at[:19], model=model_dir.name, stage=meta.get("stage"), base=meta.get("baseModel"),
        n_profiles=len(exported), torch_note="cu130 by default, TORCH_INDEX to change"), encoding="utf-8")
    job.say(f"bundle ready at {bundle}")


def _remote_root(job: ExportJob) -> str:
    if job.push and job.push.get("path"):
        base = str(job.push["path"]).rstrip("/")
        return f"{base}/{job.name}"
    return str(job.bundle_dir)


def _push(job: ExportJob) -> None:
    host = str(job.push["host"])
    base = str(job.push.get("path") or "~/voice-service").rstrip("/")
    job.status, job.step = "pushing", f"rsync to {host}:{base}/{job.name}"
    job.say(f"rsync -a --info=progress2 {job.bundle_dir}/ {host}:{base}/{job.name}/")
    cmd = ["rsync", "-a", "--info=progress2", "--rsync-path", f"mkdir -p {base}/{job.name} && rsync",
           f"{job.bundle_dir}/", f"{host}:{base}/{job.name}/"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    assert proc.stdout is not None
    last = 0.0
    for raw in proc.stdout:
        line = raw.replace("\r", "\n").strip().splitlines()
        if not line:
            continue
        now = time.monotonic()
        if now - last > 2 or "error" in line[-1].lower():
            job.say(line[-1])
            last = now
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"rsync exited {code}")
    job.say(f"pushed; on {host} run: bash {base}/{job.name}/serve/install.sh && bash {base}/{job.name}/serve/run.sh")


def _work(job: ExportJob, model_dir: Path, profiles: list[dict]) -> None:
    try:
        _build(job, model_dir, profiles)
        if job.push and job.push.get("host"):
            _push(job)
        job.status, job.step = "done", ""
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        job.say(f"FAILED {job.error}")
    finally:
        job.finished_at = datetime.now(timezone.utc).isoformat()


@router.get("/v1/export/bundles")
def list_bundles() -> list[dict]:
    out = []
    if EXPORTS_DIR.is_dir():
        for d in sorted(EXPORTS_DIR.iterdir()):
            m = d / "manifest.json"
            if not m.is_file():
                continue
            try:
                manifest = json.loads(m.read_text())
            except ValueError:
                continue
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            out.append({"name": d.name, "dir": str(d), "bytes": size, "createdAt": manifest.get("createdAt"),
                        "model": manifest.get("model", {}).get("name"), "profiles": len(manifest.get("profiles", []))})
    return out


@router.post("/v1/export")
def create_export(req: ExportRequest) -> dict:
    model_dir = _model_dir(req.model_id)
    with JOBS_LOCK:
        if any(j.status in ("queued", "copying", "pushing") for j in JOBS.values()):
            raise HTTPException(409, "an export is already running")
    name = (req.name or f"{model_dir.name}-{datetime.now(timezone.utc):%Y%m%d}").strip()
    if not name or "/" in name or name.startswith("."):
        raise HTTPException(400, "name must be a plain directory name")
    profiles = [p for p in _load_profiles() if p.get("promptAudioPath")]
    if req.profile_ids:
        wanted = set(req.profile_ids)
        profiles = [p for p in profiles if p.get("id") in wanted]
    if not profiles:
        raise HTTPException(409, "no profile with a prepared prompt to export")
    push = req.push if req.push and req.push.get("host") else None
    if push and not str(push["host"]).replace("@", "").replace(".", "").replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "push.host must look like user@host")
    job = ExportJob(uuid.uuid4().hex[:12], name, str(model_dir), push)
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=_work, args=(job, model_dir, profiles), daemon=True).start()
    return job.to_dict()


@router.get("/v1/export/jobs")
def list_jobs() -> list[dict]:
    return [j.to_dict() for j in sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)]


@router.get("/v1/export/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown export job")
    return job.to_dict()
