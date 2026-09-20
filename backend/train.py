"""Fine-tuning jobs for the studio (docs/protocol.md §3), mounted by backend/server.py.

    POST /v1/train/sft           speaker-adaptation SFT of the CosyVoice3 LLM on accepted takes
    POST /v1/train/dpo           DPO on arena preference pairs, starting from a stage-A checkpoint
    GET  /v1/train/jobs          all jobs (newest first)
    GET  /v1/train/jobs/{id}     one job with the last 60 log lines and parsed step / losses
    POST /v1/train/jobs/{id}/cancel
    GET  /v1/models              base ids + every finetuned directory under models/
    POST /v1/models/select       {id} -> hot-swap the serving engine

One job runs at a time in a background thread. Every stage is a subprocess with cwd = the
vendored CosyVoice checkout; stdout/stderr go to models/<name>/train.log. Job state is
persisted to models/jobs.json so a restart of the server keeps the history.

STUDIO_TRAIN_DRY_RUN=1 stops before torchrun and logs the exact command (used by
scripts/train-smoke.sh). A job refuses to launch torchrun with < STUDIO_TRAIN_MIN_FREE_GIB
(default 8) free on the GPU instead of OOM-ing mid-run.

Vendored-checkout patch this runner depends on: `cosyvoice/utils/train_utils.py::cosyvoice_join`
must short-circuit when WORLD_SIZE == 1 and must not read `ProcessGroup.options._timeout`
(removed in torch >= 2.6). Re-apply after updating the checkout (scripts/patch-cosyvoice.sh).
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
BASE_MODELS = ["FunAudioLLM/Fun-CosyVoice3-0.5B-2512", "FunAudioLLM/CosyVoice2-0.5B"]
DRY_RUN = os.environ.get("STUDIO_TRAIN_DRY_RUN", "0") == "1"
MIN_FREE_GIB = float(os.environ.get("STUDIO_TRAIN_MIN_FREE_GIB", "8"))
# 0.5B LLM, fp32 master weights + grads + Adam moments (~16 B/param) plus bf16 activations
# for max_frames_in_batch=2000: about 10 GiB in practice; 8 GiB is the floor we allow.
VRAM_ESTIMATE_GIB = 10.0
LOG_TAIL = 60
STATUSES_RUNNING = {"queued", "preparing", "training", "averaging", "assembling"}


def _server():
    # `python backend/server.py` runs server as __main__; importing "server" there would build a
    # second Engine. Prefer the live module.
    main = sys.modules.get("__main__")
    if main is not None and hasattr(main, "engine") and hasattr(main, "MODELS_DIR"):
        return main
    return importlib.import_module("server")


def models_dir() -> Path:
    d = Path(_server().MODELS_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def cosyvoice_repo() -> Path:
    return Path(_server().COSYVOICE_REPO)


def python_exe() -> str:
    return sys.executable


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_base(model_id: str) -> Path:
    """HF id -> cached snapshot dir; local dir -> itself."""
    if os.path.isdir(model_id):
        return Path(model_id).resolve()
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(model_id, local_files_only=True))


def training_env() -> dict[str, str]:
    repo = cosyvoice_repo()
    parts = [str(repo), str(repo / "third_party" / "Matcha-TTS")]
    try:
        importlib.import_module("deepspeed")
    except ModuleNotFoundError:
        parts.append(str(HERE / "shims"))
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(parts + [env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    # Reduce allocator fragmentation on a card this close to its limit.
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


# ---------- job store ----------

class JobStore:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.loaded = False

    def path(self) -> Path:
        return models_dir() / "jobs.json"

    def load(self) -> None:
        if self.loaded:
            return
        try:
            self.jobs = {j["id"]: j for j in json.loads(self.path().read_text())}
        except (FileNotFoundError, ValueError):
            self.jobs = {}
        # A job that was running when the server died cannot still be running.
        for j in self.jobs.values():
            if j["status"] in STATUSES_RUNNING:
                j["status"] = "failed"
                j["error"] = "server restarted while the job was running"
                j["finishedAt"] = now()
        self.loaded = True

    def save(self) -> None:
        self.path().write_text(json.dumps(list(self.jobs.values()), indent=2))

    def put(self, job: dict) -> None:
        with self.lock:
            self.load()
            self.jobs[job["id"]] = job
            self.save()

    def all(self) -> list[dict]:
        with self.lock:
            self.load()
            return sorted(self.jobs.values(), key=lambda j: j["createdAt"], reverse=True)

    def get(self, job_id: str) -> Optional[dict]:
        with self.lock:
            self.load()
            return self.jobs.get(job_id)

    def running(self) -> Optional[dict]:
        return next((j for j in self.all() if j["status"] in STATUSES_RUNNING), None)


store = JobStore()
_current_proc: Optional[subprocess.Popen] = None
_cancel_flag = threading.Event()
_worker_lock = threading.Lock()


class Cancelled(Exception):
    pass


# ---------- helpers ----------

def job_dir(name: str) -> Path:
    return models_dir() / name


def log_path(name: str) -> Path:
    return job_dir(name) / "train.log"


def append_log(name: str, line: str) -> None:
    with open(log_path(name), "a") as f:
        f.write(line.rstrip("\n") + "\n")


def run_step(job: dict, args: list[str], cwd: Path, env: dict[str, str]) -> None:
    """Run one subprocess, streaming output to the job log; raise on failure or cancel."""
    global _current_proc
    name = job["name"]
    append_log(name, f"$ (cd {cwd}) " + " ".join(args))
    proc = subprocess.Popen(args, cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    _current_proc = proc
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            append_log(name, line)
            parse_progress(job, line)
            if _cancel_flag.is_set():
                proc.terminate()
                raise Cancelled()
        proc.wait()
    finally:
        _current_proc = None
    if _cancel_flag.is_set():
        raise Cancelled()
    if proc.returncode != 0:
        raise RuntimeError(f"step failed (exit {proc.returncode}): {' '.join(args[:3])} … see train.log")


STEP_RE = re.compile(r"(TRAIN|CV) Batch (\d+)/(\d+) (.*?)(?: lr ([\d.e+-]+))?(?: grad_norm ([\d.e+-]+))?\s*rank")
EPOCH_RE = re.compile(r"Epoch (\d+) TRAIN info")


_last_persist = 0.0


def _persist_throttled(job: dict) -> None:
    """Training logs one line per batch; write jobs.json at most every 2 s."""
    global _last_persist
    if time.monotonic() - _last_persist >= 2.0:
        store.put(job)
        _last_persist = time.monotonic()


def parse_progress(job: dict, line: str) -> None:
    m = STEP_RE.search(line)
    if m:
        tag, epoch, batch, losses = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
        lm = re.search(r"\bloss ([\d.e+-]+)", losses)
        if lm:
            if tag == "TRAIN":
                job["trainLoss"] = float(lm.group(1))
                job["step"] = batch
                job["epoch"] = epoch
            else:
                job["cvLoss"] = float(lm.group(1))
        _persist_throttled(job)
        return
    m = EPOCH_RE.search(line)
    if m:
        job["epoch"] = int(m.group(1))
        store.put(job)


def set_status(job: dict, status: str, **extra) -> None:
    job["status"] = status
    job.update(extra)
    store.put(job)
    append_log(job["name"], f"== {status} ==")


def gpu_free_gib() -> Optional[float]:
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        free, _ = torch.cuda.mem_get_info()
        return free / 1024**3
    except Exception:  # noqa: BLE001
        return None


def check_vram(job: dict) -> None:
    free = gpu_free_gib()
    if free is None:
        raise RuntimeError("no CUDA device visible to the backend")
    append_log(job["name"], f"GPU free: {free:.2f} GiB (need about {VRAM_ESTIMATE_GIB:.0f} GiB, floor {MIN_FREE_GIB:.0f} GiB)")
    if free < MIN_FREE_GIB:
        raise RuntimeError(
            f"only {free:.1f} GiB free on the GPU; training needs about {VRAM_ESTIMATE_GIB:.0f} GiB. "
            "Free the card first: POST /v1/unload on this backend (the studio TTS model) and stop "
            "any other GPU-heavy service, then start the job again."
        )


# The recipe's max_frames_in_batch: 2000 fits a 24 GB card; on the 16 GB RTX 5070 Ti it
# reached 14.8 GiB and died at step 9. 1000 frames keeps the same accum_grad=2 schedule at
# about half the activation memory. Override with STUDIO_TRAIN_MAX_FRAMES.
MAX_FRAMES_IN_BATCH = int(os.environ.get("STUDIO_TRAIN_MAX_FRAMES", "1000"))


def write_train_config(base_dir: Path, work: Path, *, max_epoch: int, lr: float, log_interval: int = 1,
                       accum_grad: int = 2, cv3: bool = True, max_frames: int = MAX_FRAMES_IN_BATCH) -> Path:
    """Copy the recipe yaml with small-corpus train_conf overrides (and a GPU-sized batch)."""
    src = cosyvoice_repo() / "examples" / "libritts" / ("cosyvoice3" if cv3 else "cosyvoice2") / "conf" / (
        "cosyvoice3.yaml" if cv3 else "cosyvoice2.yaml")
    text = src.read_text()
    # train_conf block: replace the first occurrence of each key after 'train_conf:'
    head, sep, tail = text.partition("train_conf:")
    if not sep:
        raise RuntimeError(f"train_conf not found in {src}")
    block, gan_sep, gan_tail = tail.partition("train_conf_gan:")
    block = re.sub(r"(\n\s*lr:)\s*[\d.e+-]+[^\n]*", rf"\g<1> {lr}", block, count=1)
    block = re.sub(r"(\n\s*scheduler:)\s*\S+[^\n]*", r"\g<1> constantlr", block, count=1)
    block = re.sub(r"(\n\s*max_epoch:)\s*\d+", rf"\g<1> {max_epoch}", block, count=1)
    block = re.sub(r"(\n\s*accum_grad:)\s*\d+", rf"\g<1> {accum_grad}", block, count=1)
    block = re.sub(r"(\n\s*log_interval:)\s*\d+", rf"\g<1> {log_interval}", block, count=1)
    out = work / "train.yaml"
    full = head + sep + block + gan_sep + gan_tail
    full = re.sub(r"(\n\s*max_frames_in_batch:)\s*\d+", rf"\g<1> {max_frames}", full, count=1)
    out.write_text(full)
    return out


def config_hash(cfg: dict, yaml_path: Optional[Path]) -> str:
    h = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode())
    if yaml_path and yaml_path.exists():
        h.update(yaml_path.read_bytes())
    return h.hexdigest()[:12]


def torchrun_cmd(work: Path, base_dir: Path, *, yaml_path: Path, train_list: Path, dev_list: Path,
                 checkpoint: Path, dpo: bool = False, ref_model: Optional[Path] = None) -> list[str]:
    cmd = [
        python_exe(), "-m", "torch.distributed.run", "--nnodes=1", "--nproc_per_node=1",
        "--rdzv_id=" + uuid.uuid4().hex[:8], "--rdzv_backend=c10d", "--rdzv_endpoint=localhost:0",
        "cosyvoice/bin/train.py",
        "--train_engine", "torch_ddp",
        "--model", "llm",
        "--config", str(yaml_path),
        "--train_data", str(train_list),
        "--cv_data", str(dev_list),
        "--qwen_pretrain_path", str(base_dir / "CosyVoice-BlankEN"),
        "--onnx_path", str(base_dir),
        "--checkpoint", str(checkpoint),
        "--model_dir", str(work / "exp" / "llm"),
        "--tensorboard_dir", str(work / "tensorboard" / "llm"),
        "--ddp.dist_backend", "nccl",
        "--num_workers", "2", "--prefetch", "100", "--pin_memory", "--use_amp",
    ]
    if dpo:
        cmd += ["--dpo", "--ref_model", str(ref_model)]
    return cmd


def assemble_model(job: dict, base_dir: Path, llm_pt: Path, *, extra_meta: dict) -> Path:
    """models/<name>/ = symlinks to the base for everything except llm.pt, plus meta + card."""
    out = job_dir(job["name"])
    for entry in base_dir.iterdir():
        if entry.name in ("llm.pt", "llm.rl.pt", ".gitattributes"):
            continue
        target = out / entry.name
        if target.exists() or target.is_symlink():
            continue
        os.symlink(entry.resolve(), target)
    shutil.copy2(llm_pt, out / "llm.pt")
    meta = {
        "name": job["name"], "stage": job["stage"], "baseModel": job["baseModel"], "speakerId": job["speakerId"],
        "config": job["config"], "createdAt": job["createdAt"], "finishedAt": now(),
        "steps": job.get("step"), "cvLoss": job.get("cvLoss"), "trainLoss": job.get("trainLoss"), **extra_meta,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    card = f"""# {job['name']}

- **Stage**: {job['stage']} ({'speaker-adaptation SFT of the LLM' if job['stage'] == 'sft' else 'DPO on arena preference pairs'})
- **Base model**: `{job['baseModel']}`
- **Speaker**: {job['speakerId']}
- **Data**: {extra_meta.get('dataSummary', {})}
- **Config hash**: `{extra_meta.get('configHash', '')}`
- **Config**: `{json.dumps(job['config'])}`
- **Held-out loss (cv)**: {job.get('cvLoss')}
- **Train loss (last)**: {job.get('trainLoss')}
- **Created**: {job['createdAt']}

Intended use: a personal voice for the owner's own teaching material and digital human.
Trained with the protocol in `docs/protocol.md` §3 of personal-voice-clone-studio; evaluate with §2
(blind paired arena rounds against the base model — every round records this model id).
Not for impersonation; the reference recordings are private and not distributed with the model.
"""
    (out / "MODEL_CARD.md").write_text(card)
    return out


# ---------- pipelines ----------

def run_sft(job: dict) -> None:
    cfg = job["config"]
    name = job["name"]
    work = job_dir(name) / "work"
    work.mkdir(parents=True, exist_ok=True)
    base_dir = resolve_base(job["baseModel"])
    cv3 = (base_dir / "cosyvoice3.yaml").exists()
    env = training_env()
    repo = cosyvoice_repo()
    data = work / "data"

    set_status(job, "preparing", startedAt=now())
    run_step(job, [python_exe(), str(HERE / "train_tools.py"), "prepare-sft",
                   "--takes", cfg["takesFile"], "--repo-root", str(REPO_ROOT), "--out", str(data),
                   "--speaker", job["speakerId"], "--heldout", str(cfg["heldoutFraction"]), "--seed", str(cfg["seed"])]
                  + (["--include-borderline"] if cfg.get("includeBorderline") else []),
             repo, env)
    summary = json.loads((data / "summary.json").read_text())
    job["dataSummary"] = summary
    tokenizer = base_dir / ("speech_tokenizer_v3.onnx" if cv3 else "speech_tokenizer_v2.onnx")
    for split in ("train", "dev"):
        d = data / split
        run_step(job, [python_exe(), str(HERE / "train_tools.py"), "embeddings", "--dir", str(d),
                       "--onnx", str(base_dir / "campplus.onnx")], repo, env)
        run_step(job, [python_exe(), str(HERE / "train_tools.py"), "tokens", "--dir", str(d),
                       "--onnx", str(tokenizer), "--provider", "cpu" if DRY_RUN else cfg.get("tokenProvider", "cpu")], repo, env)
        (d / "parquet").mkdir(exist_ok=True)
        run_step(job, [python_exe(), "tools/make_parquet_list.py", "--num_utts_per_parquet", "200",
                       "--num_processes", "1", "--src_dir", str(d), "--des_dir", str(d / "parquet")], repo, env)
    yaml_path = write_train_config(base_dir, work, max_epoch=int(cfg["epochs"]), lr=float(cfg["lr"]), cv3=cv3)
    job["configHash"] = config_hash(cfg, yaml_path)
    store.put(job)
    cmd = torchrun_cmd(work, base_dir, yaml_path=yaml_path, train_list=data / "train" / "parquet" / "data.list",
                       dev_list=data / "dev" / "parquet" / "data.list", checkpoint=base_dir / "llm.pt")
    append_log(name, "torchrun command: " + " ".join(cmd))
    if DRY_RUN:
        set_status(job, "done", finishedAt=now(), dryRun=True)
        return

    set_status(job, "training")
    check_vram(job)
    run_step(job, cmd, repo, env)

    set_status(job, "averaging")
    exp = work / "exp" / "llm"
    n_ckpt = len(list(exp.glob("epoch_*_whole.pt")))
    if n_ckpt == 0:
        raise RuntimeError("training produced no epoch checkpoints")
    avg_num = min(int(cfg.get("averageNum", 3)), n_ckpt)
    avg_pt = work / "llm.avg.pt"
    run_step(job, [python_exe(), "cosyvoice/bin/average_model.py", "--dst_model", str(avg_pt),
                   "--src_path", str(exp), "--num", str(avg_num), "--val_best"], repo, env)

    set_status(job, "assembling")
    out = assemble_model(job, base_dir, avg_pt, extra_meta={"dataSummary": summary, "configHash": job["configHash"]})
    set_status(job, "done", finishedAt=now(), outputDir=str(out))


def run_dpo(job: dict) -> None:
    cfg = job["config"]
    name = job["name"]
    work = job_dir(name) / "work"
    work.mkdir(parents=True, exist_ok=True)
    base_dir = resolve_base(job["baseModel"])
    cv3 = (base_dir / "cosyvoice3.yaml").exists()
    env = training_env()
    repo = cosyvoice_repo()
    data = work / "data"

    set_status(job, "preparing", startedAt=now())
    run_step(job, [python_exe(), str(HERE / "train_tools.py"), "prepare-dpo",
                   "--pairs", cfg["pairsFile"], "--repo-root", str(REPO_ROOT), "--out", str(data),
                   "--profiles", str(REPO_ROOT / "data" / "voice-profiles.json"),
                   "--heldout", str(cfg["heldoutFraction"]), "--seed", str(cfg["seed"])], repo, env)
    summary = json.loads((data / "summary.json").read_text())
    job["dataSummary"] = summary
    tokenizer = base_dir / ("speech_tokenizer_v3.onnx" if cv3 else "speech_tokenizer_v2.onnx")
    provider = "cpu" if DRY_RUN else cfg.get("tokenProvider", "cpu")
    for split in ("train", "dev"):
        d = data / split
        run_step(job, [python_exe(), str(HERE / "train_tools.py"), "embeddings", "--dir", str(d),
                       "--onnx", str(base_dir / "campplus.onnx"), "--wav-scp", str(d / "prompt_wav.scp")], repo, env)
        run_step(job, [python_exe(), str(HERE / "train_tools.py"), "tokens", "--dir", str(d),
                       "--onnx", str(tokenizer), "--provider", provider], repo, env)
        run_step(job, [python_exe(), str(HERE / "train_tools.py"), "tokens", "--dir", str(data / f"{split}_reject"),
                       "--onnx", str(tokenizer), "--provider", provider], repo, env)
        (d / "parquet").mkdir(exist_ok=True)
        run_step(job, [python_exe(), "tools/make_parquet_list.py", "--num_utts_per_parquet", "200",
                       "--num_processes", "1", "--src_dir", str(d), "--des_dir", str(d / "parquet"), "--dpo"], repo, env)
    yaml_path = write_train_config(base_dir, work, max_epoch=int(cfg["epochs"]), lr=float(cfg["lr"]), cv3=cv3)
    job["configHash"] = config_hash(cfg, yaml_path)
    store.put(job)
    ref = Path(cfg["refModel"]) if cfg.get("refModel") else base_dir / "llm.pt"
    cmd = torchrun_cmd(work, base_dir, yaml_path=yaml_path, train_list=data / "train" / "parquet" / "data.list",
                       dev_list=data / "dev" / "parquet" / "data.list", checkpoint=base_dir / "llm.pt", dpo=True, ref_model=ref)
    append_log(name, "torchrun command: " + " ".join(cmd))
    append_log(name, "note: DPO beta is fixed at 0.01 inside cosyvoice/bin/train.py (DPOLoss); the request's beta is recorded only")
    if DRY_RUN:
        set_status(job, "done", finishedAt=now(), dryRun=True)
        return

    set_status(job, "training")
    check_vram(job)
    run_step(job, cmd, repo, env)

    set_status(job, "averaging")
    exp = work / "exp" / "llm"
    n_ckpt = len(list(exp.glob("epoch_*_whole.pt")))
    if n_ckpt == 0:
        raise RuntimeError("training produced no epoch checkpoints")
    avg_pt = work / "llm.avg.pt"
    run_step(job, [python_exe(), "cosyvoice/bin/average_model.py", "--dst_model", str(avg_pt),
                   "--src_path", str(exp), "--num", str(min(int(cfg.get("averageNum", 3)), n_ckpt)), "--val_best"], repo, env)

    set_status(job, "assembling")
    out = assemble_model(job, base_dir, avg_pt, extra_meta={"dataSummary": summary, "configHash": job["configHash"]})
    set_status(job, "done", finishedAt=now(), outputDir=str(out))


def worker(job: dict) -> None:
    with _worker_lock:
        _cancel_flag.clear()
        try:
            (run_sft if job["stage"] == "sft" else run_dpo)(job)
        except Cancelled:
            set_status(job, "cancelled", finishedAt=now())
        except Exception as exc:  # noqa: BLE001
            append_log(job["name"], f"ERROR {type(exc).__name__}: {exc}")
            set_status(job, "failed", finishedAt=now(), error=str(exc))


def launch(job: dict) -> dict:
    if store.running() is not None:
        raise HTTPException(409, "another training job is running")
    if job_dir(job["name"]).exists() and (job_dir(job["name"]) / "meta.json").exists():
        raise HTTPException(409, f"models/{job['name']} already exists; pick another name")
    job_dir(job["name"]).mkdir(parents=True, exist_ok=True)
    log_path(job["name"]).write_text("")
    store.put(job)
    threading.Thread(target=worker, args=(job,), daemon=True, name=f"train-{job['id'][:8]}").start()
    return job


def job_view(job: dict) -> dict:
    view = dict(job)
    try:
        lines = log_path(job["name"]).read_text().splitlines()
    except FileNotFoundError:
        lines = []
    view["logTail"] = lines[-LOG_TAIL:]
    view.setdefault("totalSteps", None)
    return view


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def check_name(name: str) -> str:
    if not NAME_RE.match(name):
        raise HTTPException(400, "name must be 1-64 chars of letters, digits, '.', '_' or '-'")
    if name in ("jobs.json",):
        raise HTTPException(400, "reserved name")
    return name


# ---------- request models ----------

class SFTRequest(BaseModel):
    name: str
    speaker_id: str = "owner"
    dataset_dir: str
    base_model: str = BASE_MODELS[0]
    epochs: int = Field(default=10, ge=1, le=500)
    lr: float = Field(default=1e-5, gt=0, le=1e-2)
    heldout_fraction: float = Field(default=0.05, ge=0.0, le=0.5)
    seed: int = 1234
    train_flow: bool = False
    average_num: int = Field(default=3, ge=1, le=20)
    token_provider: str = Field(default="cpu", pattern="^(cpu|cuda)$")
    # Borderline takes (reverb tail −25…−20 dB) are excluded unless the job opts in.
    include_borderline: bool = False


class DPORequest(BaseModel):
    name: str
    pairs_file: str
    base_model: str
    ref_model: Optional[str] = None
    beta: float = Field(default=0.01, gt=0, le=1)
    epochs: int = Field(default=3, ge=1, le=100)
    lr: float = Field(default=5e-6, gt=0, le=1e-2)
    heldout_fraction: float = Field(default=0.05, ge=0.0, le=0.5)
    seed: int = 1234
    force: bool = False
    average_num: int = Field(default=2, ge=1, le=20)
    token_provider: str = Field(default="cpu", pattern="^(cpu|cuda)$")


class SelectRequest(BaseModel):
    id: str


# ---------- endpoints ----------

@router.post("/v1/train/sft")
def start_sft(req: SFTRequest):
    name = check_name(req.name)
    takes = Path(req.dataset_dir) / "takes.jsonl"
    if not takes.is_file():
        raise HTTPException(400, f"no takes.jsonl in {req.dataset_dir}")
    accepted = [t for t in (json.loads(l) for l in open(takes) if l.strip()) if t.get("verdict") == "accept"]
    if not req.include_borderline:
        accepted = [t for t in accepted if t.get("quality", "clean") != "borderline"]
    if not accepted:
        raise HTTPException(409, "the corpus has no usable takes (clean takes only unless include_borderline is set)")
    try:
        resolve_base(req.base_model)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"base model not available locally: {exc}") from exc
    if req.train_flow:
        # The recipe supports flow training but the studio only wires the LLM stage for now.
        raise HTTPException(400, "train_flow is not supported yet; the LLM is the stage that carries speaker identity")
    job = {
        "id": str(uuid.uuid4()), "stage": "sft", "status": "queued", "name": name, "baseModel": req.base_model,
        "speakerId": req.speaker_id, "createdAt": now(),
        "config": {
            "takesFile": str(takes), "epochs": req.epochs, "lr": req.lr, "heldoutFraction": req.heldout_fraction,
            "seed": req.seed, "averageNum": req.average_num, "tokenProvider": req.token_provider,
            "acceptedTakes": len(accepted), "includeBorderline": req.include_borderline, "dryRun": DRY_RUN,
        },
    }
    return job_view(launch(job))


@router.post("/v1/train/dpo")
def start_dpo(req: DPORequest):
    name = check_name(req.name)
    pairs_file = Path(req.pairs_file)
    if not pairs_file.is_file():
        raise HTTPException(400, f"pairs file not found: {pairs_file}")
    n_pairs = sum(1 for l in open(pairs_file) if l.strip())
    if n_pairs < 200 and not req.force:
        raise HTTPException(409, f"only {n_pairs} preference pairs; DPO needs at least 200 (pass force=true to override)")
    try:
        base_dir = resolve_base(req.base_model)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"base model not available locally: {exc}") from exc
    if req.ref_model and not Path(req.ref_model).is_file():
        raise HTTPException(400, f"ref_model not found: {req.ref_model}")
    job = {
        "id": str(uuid.uuid4()), "stage": "dpo", "status": "queued", "name": name, "baseModel": str(base_dir),
        "speakerId": "owner", "createdAt": now(),
        "config": {
            "pairsFile": str(pairs_file), "pairs": n_pairs, "refModel": req.ref_model, "beta": req.beta,
            "epochs": req.epochs, "lr": req.lr, "heldoutFraction": req.heldout_fraction, "seed": req.seed,
            "averageNum": req.average_num, "tokenProvider": req.token_provider, "force": req.force, "dryRun": DRY_RUN,
        },
    }
    return job_view(launch(job))


@router.get("/v1/train/jobs")
def list_jobs():
    return [job_view(j) for j in store.all()]


@router.get("/v1/train/jobs/{job_id}")
def get_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job_view(job)


@router.post("/v1/train/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["status"] not in STATUSES_RUNNING:
        return job_view(job)
    _cancel_flag.set()
    proc = _current_proc
    if proc is not None and proc.poll() is None:
        proc.terminate()
        for _ in range(50):
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        if proc.poll() is None:
            proc.kill()
    return job_view(store.get(job_id) or job)


def list_models() -> list[dict]:
    active = _server().engine.model_id
    out = []
    for mid in BASE_MODELS:
        out.append({"id": mid, "name": mid.split("/")[-1], "kind": "base", "active": active == mid})
    for d in sorted(models_dir().iterdir()):
        if not d.is_dir() or not ((d / "cosyvoice3.yaml").exists() or (d / "cosyvoice2.yaml").exists()):
            continue
        if not (d / "llm.pt").exists():
            continue
        try:
            meta = json.loads((d / "meta.json").read_text())
        except (FileNotFoundError, ValueError):
            meta = {}
        out.append({
            "id": str(d.resolve()), "name": d.name, "kind": "finetuned", "stage": meta.get("stage"),
            "baseModel": meta.get("baseModel"), "createdAt": meta.get("createdAt"),
            "active": active in (str(d), str(d.resolve())),
        })
    return out


@router.get("/v1/models")
def get_models():
    return list_models()


@router.post("/v1/models/select")
def select_model(req: SelectRequest):
    if store.running() is not None:
        raise HTTPException(409, "a training job is running; wait for it before switching models")
    ids = {m["id"] for m in list_models()}
    if req.id not in ids and not (os.path.isdir(req.id) and (
            Path(req.id, "cosyvoice3.yaml").exists() or Path(req.id, "cosyvoice2.yaml").exists())):
        raise HTTPException(404, "unknown model id")
    srv = _server()
    srv.engine.switch(req.id)
    if srv.engine.error:
        raise HTTPException(500, srv.engine.error)
    return {"active": srv.engine.model_id, "ready": srv.engine.ready, "load_seconds": srv.engine.load_seconds}
