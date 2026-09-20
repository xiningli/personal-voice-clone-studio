"""CosyVoice2 voice-cloning server for Voice Teaching Studio.

Serves the Next.js app on http://127.0.0.1:8010 (8000 is taken on this machine):

    POST /v1/tts      text + reference prompt (+ instruct, speed, seed, mode) -> wav
    POST /v1/prepare  any recording -> clean 24 kHz prompt wav + whisper transcript
    GET  /health      model / GPU status
    POST /v1/unload   free the GPU (the digital-human backend shares the card)

Modes (chosen by `mode`, default "auto"):
    zero_shot      clone timbre AND delivery from the prompt; needs prompt_text
    instruct       clone timbre, take prosody from a natural-language instruction
                   (CosyVoice2's instruct2 path, "用开心的语气说" / "speak slowly and warmly")
    instruct_ref   instruct, but the reference clip's speech tokens stay in the LM prompt, so the
                   timbre and habits of the clip carry over while the instruction bends the prosody
                   (needs prompt_text, like zero_shot)
    cross_lingual  clone timbre only, no transcript needed (use when text language != prompt)
    auto           instruct if `instruct` is non-empty, else zero_shot if prompt_text, else cross_lingual

The CosyVoice checkout and the venv default to this repo's .venv and models/CosyVoice;
override with STUDIO_PYTHON / STUDIO_COSYVOICE_REPO / STUDIO_TTS_MODEL.
Reference audio and everything synthesized from it stay on this machine; nothing is logged
beyond timings and text lengths.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import random
import re
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))
# When launched as `python backend/server.py` this module is `__main__`; alias it so the
# feature modules' lazy `import server` reach the same Engine instead of re-executing the file.
sys.modules.setdefault("server", sys.modules[__name__])
from postprocess import trim_lead_breath  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOG = logging.getLogger("studio.tts")

REPO_ROOT = Path(__file__).resolve().parent.parent
COSYVOICE_REPO = Path(os.environ.get("STUDIO_COSYVOICE_REPO", REPO_ROOT / "models" / "CosyVoice"))
MODEL_ID = os.environ.get("STUDIO_TTS_MODEL", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")
IS_CV3 = "CosyVoice3" in MODEL_ID  # updated by Engine.switch()
# Fine-tuned checkpoints live here as complete model directories (see backend/train.py).
MODELS_DIR = Path(os.environ.get("STUDIO_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))
# CosyVoice3 was trained with a chat-style system prefix in front of every prompt text.
CV3_SYSTEM = "You are a helpful assistant."
# `medium` int8 on CPU: ~3 s per take here, noticeably fewer misreads than `small` on
# accented English and proper nouns; the model is loaded once and reused.
WHISPER_MODEL = os.environ.get("STUDIO_WHISPER_MODEL", "medium")
_WHISPER = None
PORT = int(os.environ.get("STUDIO_TTS_PORT", "8010"))
# 127.0.0.1 in the studio; an exported bundle sets 0.0.0.0 so other machines can reach it.
HOST = os.environ.get("STUDIO_TTS_HOST", "127.0.0.1")
# Reference profiles with paths on this machine: the studio's data file, or an exported
# bundle's profiles.json (paths relative to that file) when STUDIO_PROFILES_FILE is set.
PROFILES_FILE = os.environ.get("STUDIO_PROFILES_FILE", "")
# "auto" (CUDA if present, else CPU) or "mps": Apple silicon through Metal, experimental and
# unfinished — on an M4 (macOS 26, torch 2.14) the fp32 run produced silence and the fp16 run
# aborted the process. CosyVoice only knows cuda/cpu, so modules are moved after loading.
# Known: the fine-tuned checkpoint speaks correctly only in fp16 (CUDA); in fp32 on the CPU it
# babbles or reads the instruction aloud while the base model is fine (2026-09-17).
DEVICE = os.environ.get("STUDIO_DEVICE", "auto").lower()
SAMPLE_RATE = 24_000
DENOISE = "highpass=f=70,afftdn=nf=-20:tn=1,loudnorm=I=-18:TP=-1.5:LRA=11"

Mode = Literal["auto", "zero_shot", "instruct", "instruct_ref", "cross_lingual"]


def full_length_decode_mask(module) -> None:
    """Let CosyVoice2 decode under transformers >= 4.50 (compatibility patch)."""
    import torch

    original = module.Qwen2Encoder.forward_one_step
    if getattr(original, "covers_cache", False):
        return

    def forward_one_step(self, xs, masks, cache=None):
        if cache is not None:
            masks = torch.ones(1, 1, cache.get_seq_length() + xs.size(1), device=xs.device, dtype=torch.bool)
        return original(self, xs, masks, cache)

    forward_one_step.covers_cache = True
    module.Qwen2Encoder.forward_one_step = forward_one_step


def is_cv3(model_id: str, model_dir: Optional[str]) -> bool:
    if "CosyVoice3" in model_id:
        return True
    return bool(model_dir) and os.path.exists(os.path.join(model_dir, "cosyvoice3.yaml"))


def set_seed(seed: int) -> None:
    import torch

    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def soundfile_load_wav() -> None:
    """Read reference clips with soundfile instead of torchaudio.load.

    torchaudio 2.9+ routes every load through torchcodec, which needs FFmpeg's shared
    libraries on the machine; an exported bundle on a bare server has none, and a 16-bit wav
    needs none. CosyVoice's own loader is replaced in place, so both the studio and the
    exported service read clips the same way.
    """
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    from cosyvoice.utils import file_utils

    def load_wav(wav, target_sr, min_sr=16000):
        data, sr = sf.read(str(wav), dtype="float32", always_2d=True)
        speech = torch.from_numpy(np.ascontiguousarray(data.T)).mean(dim=0, keepdim=True)
        if sr != target_sr:
            assert sr >= min_sr, f"wav sample rate {sr} must be at least {min_sr}"
            speech = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)(speech)
        return speech

    file_utils.load_wav = load_wav
    # Modules that did `from cosyvoice.utils.file_utils import load_wav` hold their own name.
    for mod in list(sys.modules.values()):
        if getattr(mod, "__name__", "").startswith("cosyvoice.") and getattr(mod, "load_wav", None) is not None:
            mod.load_wav = load_wav


class Engine:
    def __init__(self) -> None:
        self.model = None
        self.lock = threading.Lock()
        self.loading = False
        self.error: Optional[str] = None
        self.load_seconds = 0.0
        self.speakers: dict[str, dict] = {}  # spk_id -> {"prompt_text": str, "wav": str}
        self.instruct_inputs: dict[tuple[str, str], dict] = {}
        self.model_id = MODEL_ID
        self.model_dir: Optional[str] = None

    # ---- lifecycle ----
    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        with self.lock:
            if self.model is not None or self.loading:
                return
            self.loading = True
        started = time.monotonic()
        try:
            import torch
            from huggingface_hub import snapshot_download

            for p in (COSYVOICE_REPO, COSYVOICE_REPO / "third_party" / "Matcha-TTS"):
                if str(p) not in sys.path:
                    sys.path.insert(0, str(p))
            from cosyvoice.cli.cosyvoice import CosyVoice2, CosyVoice3
            from cosyvoice.llm import llm as llm_module

            if os.environ.get("STUDIO_DECODE_MASK_PATCH", "1") == "1":
                full_length_decode_mask(llm_module)
            soundfile_load_wav()
            if os.path.isdir(self.model_id):
                model_dir = self.model_id  # a fine-tuned checkpoint directory
            else:
                try:
                    model_dir = snapshot_download(self.model_id, local_files_only=True)
                except Exception:
                    LOG.info("weights for %s not cached; downloading", self.model_id)
                    model_dir = snapshot_download(self.model_id)
            cls = CosyVoice3 if is_cv3(self.model_id, model_dir) else CosyVoice2
            cuda = torch.cuda.is_available()
            if cuda:
                torch.cuda.reset_peak_memory_stats()
            else:
                # An exported bundle on a machine without a usable GPU: every core helps.
                torch.set_num_threads(max(1, os.cpu_count() or 1))
                LOG.warning("no CUDA device: running on the CPU with %d threads (slow)", torch.get_num_threads())
            model = cls(model_dir, fp16=cuda)
            if DEVICE == "mps" and not cuda and torch.backends.mps.is_available():
                # Mirror the CUDA path: the LM and the flow model in fp16 on Metal (a fine-tuned
                # checkpoint that speaks in fp16 was found to babble in fp32), the vocoder on the
                # CPU because its f0 predictor needs float64, which Metal lacks.
                mps = torch.device("mps")
                model.model.llm.to(mps).half()
                model.model.flow.to(mps).half()
                model.model.fp16 = True
                model.model.device = mps
                model.frontend.device = mps
                hift = model.model.hift.to("cpu").float()
                original_inference = type(hift).inference

                def inference(self, speech_feat, finalize=True):
                    out, source = original_inference(self, speech_feat.detach().to("cpu", torch.float32), finalize)
                    return out.to(mps), source.to(mps)

                hift.inference = inference.__get__(hift, type(hift))
                LOG.warning("MPS (experimental): llm/flow fp16 on Metal, hift on the CPU")
            self.model = model
            self.model_dir = model_dir
            self.error = None
            self.load_seconds = round(time.monotonic() - started, 2)
            LOG.info("%s ready in %.2fs; peak %.2f GiB", self.model_id, self.load_seconds,
                     torch.cuda.max_memory_allocated() / 1024**3 if cuda else 0.0)
        except Exception as exc:  # noqa: BLE001
            LOG.exception("failed to load %s", self.model_id)
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.loading = False

    def switch(self, model_id: str) -> None:
        """Unload the current model and load another (HF id or a local checkpoint directory)."""
        global MODEL_ID, IS_CV3
        self.unload()
        self.model_id = model_id
        MODEL_ID = model_id
        IS_CV3 = is_cv3(model_id, model_id if os.path.isdir(model_id) else None)
        self.load()

    def unload(self) -> None:
        with self.lock:
            if self.model is None:
                return
            import gc
            import torch

            self.model = None
            self.speakers.clear()
            self.instruct_inputs.clear()
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            LOG.info("model released")

    # ---- speakers ----
    def speaker_id(self, wav: Path, prompt_text: str) -> str:
        stat = wav.stat()
        key = f"{wav.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{prompt_text}"
        spk = "spk_" + hashlib.sha1(key.encode()).hexdigest()[:16]
        if spk not in self.speakers:
            # Encodes the prompt once (speech tokens, mel, x-vector); every later call
            # for this reference skips the prompt-encoding path.
            self.model.add_zero_shot_spk(prompt_text, str(wav), spk)
            self.speakers[spk] = {"prompt_text": prompt_text, "wav": str(wav)}
            LOG.info("cached speaker %s from %s (%d transcript chars)", spk, wav.name, len(prompt_text))
        return spk

    def _instruct_base(self, spk: str, instruct: str, prompt_text: str = "", keep_ref: bool = False) -> dict:
        """Cached speaker + instruction as the LM text prefix.

        CosyVoice2.inference_instruct2 ignores `instruct_text` whenever a cached speaker is
        passed (frontend_zero_shot returns the stored dict untouched), so the input is
        assembled here: the instruction replaces the reference transcript as prompt_text
        and the LM's prompt speech tokens are dropped, exactly as frontend_instruct2 does
        for the uncached path. Flow conditioning (mel + x-vector) stays the owner's.

        `keep_ref` (instruct_ref mode) keeps the clip's speech tokens and puts its transcript
        after the instruction, "<system> <instruct><|endofprompt|><transcript>", so the LM
        continues the owner's own speech under the instruction instead of starting cold.
        """
        key = (spk, instruct, prompt_text if keep_ref else "")
        base = self.instruct_inputs.get(key)
        if base is None:
            frontend = self.model.frontend
            prefix = f"{CV3_SYSTEM} " if IS_CV3 else ""
            tail = prompt_text.strip() if keep_ref else ""
            normalized = frontend.text_normalize(prefix + instruct + "<|endofprompt|>" + tail, split=False)
            tokens, length = frontend._extract_text_token(normalized)
            base = {**frontend.spk2info[spk], "prompt_text": tokens, "prompt_text_len": length}
            if not keep_ref:
                base.pop("llm_prompt_speech_token", None)
                base.pop("llm_prompt_speech_token_len", None)
            self.instruct_inputs[key] = base
        return base

    # ---- synthesis ----
    def synthesize(self, text: str, wav: Path, prompt_text: str, instruct: str, mode: Mode,
                   speed: float, seed: int) -> tuple[np.ndarray, str]:
        import torch

        if mode == "auto":
            mode = "instruct" if instruct.strip() else ("zero_shot" if prompt_text.strip() else "cross_lingual")
        if mode == "zero_shot" and not prompt_text.strip():
            raise HTTPException(400, "zero_shot mode needs prompt_text (the transcript of the reference clip)")
        if mode in ("instruct", "instruct_ref") and not instruct.strip():
            raise HTTPException(400, f"{mode} mode needs a non-empty instruct string")
        if mode == "instruct_ref" and not prompt_text.strip():
            raise HTTPException(400, "instruct_ref mode needs prompt_text (the transcript of the reference clip)")

        with self.lock:
            if self.model is None:
                raise HTTPException(503, "model not loaded")
            model = self.model
            frontend = model.frontend
            set_seed(seed)
            # cross_lingual and instruct never feed the transcript to the LM, so key the
            # speaker on an empty transcript there: one cached prompt serves both.
            # CosyVoice3 expects "You are a helpful assistant.<|endofprompt|>" before the
            # reference transcript (zero-shot) or before the text itself (cross-lingual).
            spk_prompt = prompt_text.strip() if mode == "zero_shot" else ""
            if IS_CV3 and mode == "zero_shot":
                spk_prompt = f"{CV3_SYSTEM}<|endofprompt|>{spk_prompt}"
            spk = self.speaker_id(wav, spk_prompt)
            pieces: list[torch.Tensor] = []
            if mode == "zero_shot":
                outputs = model.inference_zero_shot(text, "", str(wav), zero_shot_spk_id=spk, stream=False, speed=speed)
                for out in outputs:
                    pieces.append(out["tts_speech"])
            elif mode == "cross_lingual":
                cl_text = f"{CV3_SYSTEM}<|endofprompt|>{text}" if IS_CV3 else text
                outputs = model.inference_cross_lingual(cl_text, str(wav), zero_shot_spk_id=spk, stream=False, speed=speed)
                for out in outputs:
                    pieces.append(out["tts_speech"])
            else:
                base = self._instruct_base(spk, instruct.strip(), prompt_text, keep_ref=mode == "instruct_ref")
                for segment in frontend.text_normalize(text, split=True):
                    model_input = {**base}
                    model_input["text"], model_input["text_len"] = frontend._extract_text_token(segment)
                    for out in model.model.tts(**model_input, stream=False, speed=speed):
                        pieces.append(out["tts_speech"])
        if not pieces:
            raise HTTPException(500, "the model produced no audio")
        speech = torch.cat(pieces, dim=1).squeeze(0).clamp(-1.0, 1.0)
        return speech.float().cpu().numpy(), mode

    @property
    def sample_rate(self) -> int:
        return int(getattr(self.model, "sample_rate", SAMPLE_RATE)) if self.model is not None else SAMPLE_RATE


engine = Engine()
app = FastAPI(title="Voice Teaching Studio TTS")


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    reference_audio: str
    prompt_text: str = ""
    instruct: str = Field(default="", max_length=300)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    seed: Optional[int] = None
    mode: Mode = "auto"
    trim_breath: bool = True


class PrepareRequest(BaseModel):
    source_audio: str
    out_wav: str
    transcript: Optional[str] = None
    language: str = "auto"
    max_seconds: float = Field(default=12.0, ge=3.0, le=30.0)
    # False = the source is already a clean prompt (e.g. an imported prepared clip):
    # only convert to mono 24 kHz PCM, no denoise / loudnorm / run selection.
    process: bool = True


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(samples * 32767, -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.get("/health")
def health():
    info = {
        "status": "ok",
        "model": engine.model_id,
        "model_dir": engine.model_dir,
        "ready": engine.ready,
        "loading": engine.loading,
        "error": engine.error,
        "load_seconds": engine.load_seconds,
        "cosyvoice_repo": str(COSYVOICE_REPO),
        "cached_speakers": len(engine.speakers),
        "port": PORT,
    }
    try:
        import torch

        info["device"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            info["gpu_free_gib"] = round(free / 1024**3, 2)
            info["gpu_total_gib"] = round(total / 1024**3, 2)
    except Exception:  # noqa: BLE001
        pass
    return info


@app.post("/v1/load")
def load():
    if not engine.ready:
        engine.load()
    if engine.error:
        raise HTTPException(500, engine.error)
    return {"ready": engine.ready, "load_seconds": engine.load_seconds}


@app.post("/v1/unload")
def unload():
    engine.unload()
    return {"ready": engine.ready}


@app.post("/v1/tts")
def tts(req: TTSRequest):
    wav = Path(req.reference_audio)
    if not wav.is_file():
        raise HTTPException(400, f"reference audio not found: {wav}")
    if not engine.ready:
        engine.load()
        if not engine.ready:
            raise HTTPException(503, engine.error or "model failed to load")
    seed = req.seed if req.seed is not None else random.randint(0, 2**31 - 1)
    started = time.monotonic()
    samples, mode = engine.synthesize(req.text, wav, req.prompt_text, req.instruct, req.mode, req.speed, seed)
    sr = engine.sample_rate
    trimmed_ms = 0
    if req.trim_breath:
        samples, trimmed_ms = trim_lead_breath(samples, req.text, sr)
    elapsed = time.monotonic() - started
    duration = len(samples) / sr
    LOG.info("tts mode=%s chars=%d instruct=%d seed=%d speed=%.2f -> %.2fs audio in %.2fs (rtf %.2f, breath -%dms)",
             mode, len(req.text), len(req.instruct), seed, req.speed, duration, elapsed,
             elapsed / max(duration, 1e-3), trimmed_ms)
    return Response(
        content=wav_bytes(samples, sr),
        media_type="audio/wav",
        headers={
            "x-model": engine.model_id,
            "x-sample-rate": str(sr),
            "x-audio-duration": f"{duration:.3f}",
            "x-elapsed-seconds": f"{elapsed:.3f}",
            "x-seed": str(seed),
            "x-mode": mode,
            "x-trimmed-ms": str(trimmed_ms),
        },
    )


# ---- reference preparation ----

def _run(args: list[str]) -> str:
    done = subprocess.run(args, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise HTTPException(500, f"{args[0]} failed: {done.stderr[-800:]}")
    return done.stderr


def _duration(path: Path) -> float:
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    try:
        return float(probe.stdout.strip())
    except ValueError:
        raise HTTPException(400, "ffprobe could not read the recording") from None


def _speech_runs(path: Path, total: float) -> list[tuple[float, float]]:
    log = _run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                "silencedetect=noise=-35dB:d=0.6", "-f", "null", "-"])
    edges = [float(v) for v in re.findall(r"silence_(?:start|end): ([\d.]+)", log)]
    bounds = [0.0, *edges, total]
    runs = [(bounds[i], bounds[i + 1]) for i in range(0, len(bounds) - 1, 2)]
    return [(a, b) for a, b in runs if b - a > 0.3]


def _pauses(path: Path) -> list[float]:
    """Start times of short pauses (>= 0.2 s under -30 dB): phrase and sentence boundaries."""
    log = _run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                "silencedetect=noise=-30dB:d=0.2", "-f", "null", "-"])
    return [float(v) for v in re.findall(r"silence_start: ([\d.]+)", log)]


def _transcribe(path: Path, language: str) -> tuple[str, str]:
    global _WHISPER
    if _WHISPER is None:
        from faster_whisper import WhisperModel

        _WHISPER = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    model = _WHISPER
    lang = None if language == "auto" else language
    segments, info = model.transcribe(str(path), beam_size=5, language=lang)
    text = "".join(s.text for s in segments).strip()
    detected = info.language if info is not None else (language if language != "auto" else "en")
    return text, detected


@app.post("/v1/prepare")
def prepare(req: PrepareRequest):
    """Decode any recording, denoise, pick the best speech run, cap it, write 24 kHz mono wav."""
    src = Path(req.source_audio)
    if not src.is_file():
        raise HTTPException(400, f"source audio not found: {src}")
    out = Path(req.out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not req.process:
        _run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
              "-t", f"{req.max_seconds:.3f}", "-c:a", "pcm_s16le", str(out)])
        duration = _duration(out)
        if req.transcript and req.transcript.strip():
            transcript, language = req.transcript.strip(), req.language
            if language == "auto":
                language = "zh" if re.search(r"[\u4e00-\u9fff]", transcript) else "en"
        else:
            transcript, language = _transcribe(out, req.language)
        LOG.info("copied prepared prompt %s: %.2fs, lang=%s", out.name, duration, language)
        return {"prompt_wav": str(out), "transcript": transcript, "duration": round(duration, 3),
                "language": language, "source_duration": round(duration, 3), "segment": [0.0, round(duration, 3)]}
    tmp = out.with_suffix(".denoised.wav")
    _run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
          "-af", DENOISE, "-c:a", "pcm_s16le", str(tmp)])
    total = _duration(tmp)
    runs = _speech_runs(tmp, total) or [(0.0, total)]
    # Merge adjacent runs while the merged span stays under the cap: a natural pause inside
    # the prompt is fine, the goal is the longest continuous stretch of actual speech.
    # Every window that starts at a speech run and extends across following runs while
    # it fits the cap; keep the one holding the most speech.
    def speech_in(a: float, b: float) -> float:
        return sum(max(0.0, min(b, r1) - max(a, r0)) for r0, r1 in runs)

    windows = [(a, min(total, a + req.max_seconds)) for a, _ in runs]
    start, end = max(windows, key=lambda w: speech_in(*w))
    # Pull the end back to the last speech run inside the window so the prompt does not
    # finish on silence or a chopped word.
    inside = [r for r in runs if r[0] < end]
    end = min(end, inside[-1][1]) if inside else end
    capped = speech_in(end, total) > 0.3
    if capped:
        # The cap lands inside continuous speech. Never cut a word in half: move the end
        # back to the last phrase pause, as long as at least half the cap (and 3 s) stays.
        floor = start + max(3.0, req.max_seconds * 0.5)
        candidates = [t for t in _pauses(tmp) if floor <= t <= end]
        if candidates:
            end = candidates[-1]
    # Keep the pad the silence detector already sits inside; then cap.
    start = max(0.0, start - 0.05)
    end = min(total, end + 0.1, start + req.max_seconds)
    if end - start < 1.0:
        raise HTTPException(400, f"only {end - start:.1f}s of speech found; record at least 3 s")
    # Input-side seeking (-ss/-to before -i) restarts timestamps at zero, which the fade
    # filters need; with output-side seeking the fade-out lands before the cut and the
    # whole prompt comes out silent.
    _run(["ffmpeg", "-hide_banner", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(tmp),
          "-af", "afade=t=in:d=0.02,afade=t=out:st={:.3f}:d=0.03".format(end - start - 0.03),
          "-c:a", "pcm_s16le", str(out)])
    tmp.unlink(missing_ok=True)
    duration = _duration(out)
    speech_total = sum(b - a for a, b in runs)
    covers_all = speech_in(start, end) >= 0.95 * speech_total
    if req.transcript and req.transcript.strip() and covers_all:
        # The given transcript matches the prompt only when the cut kept (almost) all the
        # speech; a transcript of words that are not in the clip misleads zero-shot mode.
        transcript, language, source = req.transcript.strip(), req.language, "given"
        if language == "auto":
            language = "zh" if re.search(r"[一-鿿]", transcript) else "en"
    else:
        transcript, language = _transcribe(out, req.language)
        source = "whisper"
    LOG.info("prepared %s: %.2fs from %.2fs source (run %.2f-%.2f%s), %d transcript chars (%s), lang=%s",
             out.name, duration, total, start, end, ", capped at a pause" if capped else "",
             len(transcript), source, language)
    return {"prompt_wav": str(out), "transcript": transcript, "transcript_source": source,
            "duration": round(duration, 3), "language": language, "source_duration": round(total, 3),
            "segment": [round(start, 3), round(end, 3)], "capped": capped}


@app.get("/v1/profiles")
def list_profiles() -> list[dict]:
    """Reference clips this machine can synthesize from, with absolute wav paths, so a client on
    another host (the digital human, the motion arena) never needs the studio's files."""
    root = Path(__file__).resolve().parent.parent
    out: list[dict] = []
    if PROFILES_FILE:
        src = Path(PROFILES_FILE)
        try:
            items = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return out
        for p in items:
            wav = (src.parent.parent / p["wav"]).resolve() if not os.path.isabs(p.get("wav", "")) else Path(p["wav"])
            out.append({**p, "wav": str(wav)})
        return out
    try:
        items = json.loads((root / "data" / "voice-profiles.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    for p in items:
        if not p.get("promptAudioPath"):
            continue
        out.append({"id": p.get("id"), "name": p.get("name"), "emotion": p.get("emotion", "neutral"), "language": p.get("language", "en"),
                    "wav": str(root / "public" / str(p["promptAudioPath"]).lstrip("/")), "promptText": p.get("promptText", ""),
                    "durationSeconds": p.get("durationSeconds")})
    return out


# Optional feature modules, each exposing a FastAPI `router`; they import this module
# lazily inside their handlers to reach `engine`, `MODEL_ID`, `MODELS_DIR`, `_run`, `_transcribe`.
import importlib  # noqa: E402

for _name in ("qc", "metrics", "train", "export"):
    try:
        _mod = importlib.import_module(_name)
    except ModuleNotFoundError as exc:
        if exc.name != _name:
            LOG.warning("feature module %s failed to import: %s", _name, exc)
        continue
    app.include_router(_mod.router)
    LOG.info("feature module %s mounted", _name)


if __name__ == "__main__":
    import uvicorn

    if os.environ.get("STUDIO_TTS_PRELOAD", "1") == "1":
        engine.load()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
