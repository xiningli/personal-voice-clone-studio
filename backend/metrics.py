"""Objective metrics for synthesized (or recorded) candidates — docs/protocol.md §2.

    POST /v1/metrics {wav_path, text, reference_wav, language}
      -> {wer, transcript, speaker_similarity, reverb_tail_db, duration}

Speaker similarity is the cosine between CAM++ x-vectors, extracted exactly the way
CosyVoice's frontend does it (16 kHz, kaldi fbank 80 mel, mean-normalised, campplus.onnx on
CPU), so the number is the same SECS the model itself conditions on. It is a sanity check,
not a substitute for the human similarity rating.

Mounted by server.py; helpers from server are imported lazily inside handlers.
"""
from __future__ import annotations

import logging
import re
import threading
import wave
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

LOG = logging.getLogger("studio.metrics")
router = APIRouter()

_session = None
_session_path: Optional[str] = None
_session_lock = threading.Lock()


class MetricsRequest(BaseModel):
    wav_path: str
    text: str = ""
    reference_wav: Optional[str] = None
    language: str = "en"


def _campplus_path() -> Path:
    import server

    if server.engine.model_dir:
        candidate = Path(server.engine.model_dir) / "campplus.onnx"
        if candidate.exists():
            return candidate
    from huggingface_hub import snapshot_download

    model_dir = snapshot_download(server.MODEL_ID, local_files_only=True)
    candidate = Path(model_dir) / "campplus.onnx"
    if not candidate.exists():
        raise HTTPException(500, f"campplus.onnx not found under {model_dir}")
    return candidate


def _campplus_session():
    global _session, _session_path
    path = str(_campplus_path())
    with _session_lock:
        if _session is None or _session_path != path:
            import onnxruntime

            option = onnxruntime.SessionOptions()
            option.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
            option.intra_op_num_threads = 1
            _session = onnxruntime.InferenceSession(path, sess_options=option, providers=["CPUExecutionProvider"])
            _session_path = path
            LOG.info("campplus session loaded from %s", path)
        return _session


def _load_wav_16k(path: Path):
    import torchaudio

    speech, sr = torchaudio.load(str(path), backend="soundfile")
    speech = speech.mean(dim=0, keepdim=True)
    if sr != 16000:
        speech = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(speech)
    return speech


def xvector(path: Path) -> np.ndarray:
    """CAM++ embedding, identical to CosyVoiceFrontEnd._extract_spk_embedding."""
    import torchaudio.compliance.kaldi as kaldi

    speech = _load_wav_16k(path)
    feat = kaldi.fbank(speech, num_mel_bins=80, dither=0, sample_frequency=16000)
    feat = feat - feat.mean(dim=0, keepdim=True)
    session = _campplus_session()
    out = session.run(None, {session.get_inputs()[0].name: feat.unsqueeze(dim=0).cpu().numpy()})[0]
    return np.asarray(out, dtype=np.float64).flatten()


def speaker_similarity(a: Path, b: Path) -> float:
    va, vb = xvector(a), xvector(b)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb)) + 1e-12
    return float(np.dot(va, vb) / denom)


def _read_pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as w:
        sr = w.getframerate()
        n = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise HTTPException(400, f"{path.name}: only 16-bit PCM wav is supported")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if n > 1:
        x = x.reshape(-1, n).mean(axis=1)
    return x, sr


def reverb_tail_db(x: np.ndarray, sr: int) -> Optional[float]:
    """Room reverb estimate in dB, level-independent.

    Reference = the take's loud level (95th percentile of 10 ms frame RMS). Speech frames are
    those within 12 dB of it. At every speech offset (including the end of the take, which is
    padded with 200 ms of silence so the last word always counts) the energy 60-160 ms after
    the offset is compared with the reference. A dry close mic decays to the noise floor
    (below -35 dB); an untreated room sits around -15 to -25 dB.
    """
    w = int(sr * 0.01)
    x = np.concatenate([x, np.zeros(int(sr * 0.2), dtype=x.dtype)])
    n = len(x) // w
    if n < 30:
        return None
    rms = np.sqrt(np.mean(x[: n * w].reshape(n, w) ** 2, axis=1) + 1e-12)
    db = 20.0 * np.log10(rms)
    loud = db[db > -80.0]
    if len(loud) < 10:
        return None
    ref_db = float(np.percentile(loud, 95))
    ref_rms = 10 ** (ref_db / 20.0)
    # A word "ends" when the level drops 12 dB under the loud level; measuring later along
    # the decay would understate the room.
    voiced = db > ref_db - 12.0
    ratios = []
    for i in range(10, n - 16):
        if voiced[i - 1] and not voiced[i] and not voiced[i : i + 16].any():
            after = rms[i + 6 : i + 16].mean()
            ratios.append(20.0 * np.log10(after / ref_rms + 1e-9))
    if not ratios:
        return None
    return float(np.median(ratios))

_EN_NORMALIZER = None


def _norm_words(s: str) -> list[str]:
    """Same normalisation as qc.py: Whisper's EnglishTextNormalizer for English (contractions,
    numerals, spelling variants), character units for Chinese."""
    global _EN_NORMALIZER
    s = s.lower().replace("’", "'")
    if re.search(r"[一-鿿]", s):
        s = re.sub(r"[^a-z0-9' 一-鿿]", " ", s)
        return [ch for ch in re.sub(r"\s+", "", s) if ch.strip()]
    if _EN_NORMALIZER is None:
        try:
            from whisper.normalizers import EnglishTextNormalizer

            _EN_NORMALIZER = EnglishTextNormalizer()
        except Exception:  # noqa: BLE001
            _EN_NORMALIZER = False
    if _EN_NORMALIZER:
        return _EN_NORMALIZER(s).split()
    return re.sub(r"[^a-z0-9' ]+", " ", s).split()


def word_error_rate(ref: str, hyp: str) -> float:
    r, h = _norm_words(ref), _norm_words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=np.int32)
    d[:, 0] = np.arange(len(r) + 1)
    d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return round(float(d[len(r), len(h)]) / len(r), 4)


@router.post("/v1/metrics")
def metrics(req: MetricsRequest):
    import server

    wav = Path(req.wav_path)
    if not wav.is_file():
        raise HTTPException(400, f"wav not found: {wav}")
    x, sr = _read_pcm(wav)
    duration = round(len(x) / sr, 3)
    out: dict = {
        "duration": duration,
        "reverb_tail_db": reverb_tail_db(x, sr),
        "wer": None,
        "transcript": "",
        "speaker_similarity": None,
    }
    if req.text.strip():
        try:
            transcript, _lang = server._transcribe(wav, req.language or "auto")
            out["transcript"] = transcript
            out["wer"] = word_error_rate(req.text, transcript)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("transcription failed for %s: %s", wav.name, exc)
    if req.reference_wav:
        ref = Path(req.reference_wav)
        if ref.is_file():
            try:
                out["speaker_similarity"] = round(speaker_similarity(wav, ref), 4)
            except Exception as exc:  # noqa: BLE001
                LOG.warning("speaker similarity failed for %s: %s", wav.name, exc)
        else:
            LOG.warning("reference wav not found: %s", ref)
    LOG.info("metrics %s: dur=%.2fs wer=%s sim=%s tail=%s", wav.name, duration, out["wer"],
             out["speaker_similarity"], out["reverb_tail_db"])
    return out
