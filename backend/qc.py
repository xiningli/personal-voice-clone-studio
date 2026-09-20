"""Quality control for corpus takes (docs/protocol.md §1).

Mounted by server.py as a feature module. `POST /v1/qc` decodes any recording to mono
24 kHz 16-bit PCM, trims leading/trailing silence, writes the take, and measures it. The
take is never denoised: the corpus must be raw and clean, and these metrics are what
enforce "clean". Everything here runs on CPU.
"""
from __future__ import annotations

import re
import wave
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# One place for the acceptance rules. Keys match TakeMetrics; values are the limits.
THRESHOLDS = {
    "min_duration_s": 1.0,
    "max_duration_s": 30.0,  # the emotion scripts run 15-25 s when read slowly; CosyVoice trains on up to 30 s
    "max_peak_dbfs": -1.0,
    "max_clipping_ratio": 0.001,
    "max_noise_floor_db": -45.0,
    "min_snr_db": 30.0,                    # clean tier
    "min_snr_borderline_db": 24.0,         # accepted with quality "borderline"; lower is rejected
    "quiet_peak_dbfs": -18.0,              # below this the take is accepted but flagged as quiet
    "max_reverb_tail_db": -25.0,          # clean tier
    "max_reverb_tail_borderline_db": -20.0,  # accepted with quality "borderline"; worse is rejected
    "max_wer": 0.10,
    # A short ARCTIC sentence has 8-12 words, so one ASR slip already exceeds 10 %. A take is
    # rejected for intelligibility only when the rate is over the limit AND at least this many
    # words differ; a single disputed word on a short sentence is not a misread.
    "min_word_errors_to_reject": 3,
}

FRAME_S = 0.01
TRIM_DB = -40.0
TRIM_PAD_S = 0.05


class QCRequest(BaseModel):
    source_audio: str
    out_wav: str
    text: str
    language: str = "en"
    emotion: Optional[str] = None


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    return x, sr


def _write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    pcm = np.clip(x * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _frame_rms_db(x: np.ndarray, sr: int) -> np.ndarray:
    w = max(1, int(sr * FRAME_S))
    n = len(x) // w
    if n == 0:
        return np.array([])
    rms = np.sqrt(np.mean(x[: n * w].reshape(n, w) ** 2, axis=1) + 1e-12)
    return 20.0 * np.log10(rms)


def trim_bounds(x: np.ndarray, sr: int) -> tuple[int, int]:
    """Sample range that keeps everything above TRIM_DB plus TRIM_PAD_S on each side."""
    db = _frame_rms_db(x, sr)
    if len(db) == 0:
        return 0, len(x)
    loud = np.where(db > TRIM_DB)[0]
    if len(loud) == 0:
        return 0, len(x)
    w = int(sr * FRAME_S)
    pad = int(sr * TRIM_PAD_S)
    return max(0, loud[0] * w - pad), min(len(x), (loud[-1] + 1) * w + pad)


def trim_silence(x: np.ndarray, sr: int) -> np.ndarray:
    """Cut leading/trailing frames under TRIM_DB, keeping TRIM_PAD_S on each side."""
    start, end = trim_bounds(x, sr)
    return x[start:end]


def noise_floor_from_edges(raw: np.ndarray, sr: int, start: int, end: int) -> Optional[float]:
    """Noise floor from the silence the trim removed (median 10 ms frame level, dB).

    A single read sentence has no internal pause, so "the quietest 10 % of frames" inside
    the trimmed take lands on soft consonants and overstates the noise, which then
    understates SNR. The lead-in and tail the speaker leaves around the sentence are real
    silence; use them when at least 200 ms exist.
    """
    edges = np.concatenate([raw[:start], raw[end:]])
    if len(edges) < sr * 0.2:
        return None
    db = _frame_rms_db(edges, sr)
    if len(db) < 5:
        return None
    return float(np.median(db))


def reverb_tail_db(x: np.ndarray, sr: int) -> Optional[float]:
    """Room reverb estimate in dB, level-independent.

    Reference = the take's loud level (95th percentile of 10 ms frame RMS). Speech frames are
    those within 12 dB of it. At every speech offset (including the end of the take, which is
    padded with 200 ms of silence so the last word always counts) the energy 60-160 ms after
    the offset is compared with the reference. A dry close mic decays to the noise floor
    (below -35 dB); an untreated room sits around -15 to -25 dB.
    """
    w = int(sr * FRAME_S)
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
    """Whisper's EnglishTextNormalizer when available: contractions, numerals, spelling and
    punctuation variants ("we'll" vs "we will", "twentieth" vs "20th") stop counting as
    word errors. Falls back to lowercase-and-strip."""
    global _EN_NORMALIZER
    if _EN_NORMALIZER is None:
        try:
            from whisper.normalizers import EnglishTextNormalizer

            _EN_NORMALIZER = EnglishTextNormalizer()
        except Exception:  # noqa: BLE001
            _EN_NORMALIZER = False
    if _EN_NORMALIZER:
        return _EN_NORMALIZER(s).split()
    return re.sub(r"[^a-z0-9' ]+", " ", s.lower()).split()


def word_error_rate(ref: str, hyp: str) -> float:
    errors, n = word_errors(ref, hyp)
    return errors / n if n else (0.0 if not _norm_words(hyp) else 1.0)


def word_errors(ref: str, hyp: str) -> tuple[int, int]:
    """(edit distance in words, reference word count) after normalisation."""
    r, h = _norm_words(ref), _norm_words(hyp)
    if not r:
        return (len(h), 0)
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=np.int32)
    d[:, 0] = np.arange(len(r) + 1)
    d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return int(d[-1, -1]), len(r)


def measure(x: np.ndarray, sr: int, text: str, transcript: str, noise_floor_override: Optional[float] = None) -> dict:
    duration = len(x) / sr
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    peak_dbfs = 20.0 * np.log10(peak + 1e-9)
    clipping = float(np.mean(np.abs(x) >= 0.999)) if len(x) else 0.0
    db = _frame_rms_db(x, sr)
    if len(db) >= 10:
        s = np.sort(db)
        noise_floor = float(np.mean(s[: max(1, len(s) // 10)]))
        speech = float(np.mean(s[len(s) // 2 :]))
    else:
        noise_floor = float(db.min()) if len(db) else -100.0
        speech = float(db.max()) if len(db) else -100.0
    if noise_floor_override is not None:
        noise_floor = noise_floor_override
    return {
        "duration": round(duration, 3),
        "peakDbfs": round(peak_dbfs, 2),
        "clippingRatio": round(clipping, 6),
        "noiseFloorDb": round(noise_floor, 2),
        "snrDb": round(speech - noise_floor, 2),
        "reverbTailDb": None if (rt := reverb_tail_db(x, sr)) is None else round(rt, 2),
        "wer": round(word_error_rate(text, transcript), 4),
        "wordErrors": word_errors(text, transcript)[0],
        "refWords": word_errors(text, transcript)[1],
        "transcript": transcript,
    }


def judge(m: dict) -> tuple[str, list[str], str, list[str]]:
    """Return (verdict, reasons, quality, warnings).

    quality is "clean" or "borderline". Borderline = every hard check passed but the reverb
    tail sits between the clean limit and the borderline limit; the take is accepted, tagged,
    counted separately, and left out of training unless the job opts in. Provenance over
    silent alteration: the corpus records which tier every sentence came from.
    """
    t = THRESHOLDS
    reasons: list[str] = []
    warnings: list[str] = []
    quality = "clean"
    if m["duration"] < t["min_duration_s"]:
        reasons.append(f"duration {m['duration']:.1f}s < {t['min_duration_s']}s")
    if m["duration"] > t["max_duration_s"]:
        reasons.append(f"duration {m['duration']:.1f}s > {t['max_duration_s']}s")
    if m["peakDbfs"] > t["max_peak_dbfs"]:
        reasons.append(f"peak {m['peakDbfs']:.1f} dBFS > {t['max_peak_dbfs']} dBFS")
    if m["clippingRatio"] > t["max_clipping_ratio"]:
        reasons.append(f"clipping {m['clippingRatio'] * 100:.2f}% > {t['max_clipping_ratio'] * 100:.1f}%")
    if m["noiseFloorDb"] > t["max_noise_floor_db"]:
        reasons.append(f"noise floor {m['noiseFloorDb']:.1f} dB > {t['max_noise_floor_db']} dB")
    if m["snrDb"] < t["min_snr_borderline_db"]:
        reasons.append(f"SNR {m['snrDb']:.1f} dB < {t['min_snr_borderline_db']} dB")
    elif m["snrDb"] < t["min_snr_db"]:
        quality = "borderline"
        warnings.append(f"SNR {m['snrDb']:.1f} dB is between {t['min_snr_borderline_db']} and {t['min_snr_db']} dB: borderline noise")
    if m["peakDbfs"] < t["quiet_peak_dbfs"]:
        warnings.append(f"quiet signal: peak {m['peakDbfs']:.1f} dBFS (aim for -12 to -3 dBFS); low level is what drags the SNR down")
    rt = m["reverbTailDb"]
    if rt is not None and rt > t["max_reverb_tail_borderline_db"]:
        reasons.append(f"reverb tail {rt:.1f} dB > {t['max_reverb_tail_borderline_db']} dB")
    elif rt is not None and rt > t["max_reverb_tail_db"]:
        quality = "borderline"
        warnings.append(f"reverb tail {rt:.1f} dB is between {t['max_reverb_tail_db']} and {t['max_reverb_tail_borderline_db']} dB: borderline room sound")
    if m["wer"] > t["max_wer"] and m.get("wordErrors", 99) >= t["min_word_errors_to_reject"]:
        reasons.append(f"WER {m['wer']:.2f} > {t['max_wer']} ({m.get('wordErrors')} of {m.get('refWords')} words differ)")
    elif m["wer"] > t["max_wer"]:
        warnings.append(f"{m.get('wordErrors')} word(s) differ from the prompt (WER {m['wer']:.2f}); accepted, check the heard text")
    return ("reject" if reasons else "accept"), reasons, quality, warnings


@router.get("/v1/qc/thresholds")
def thresholds():
    return THRESHOLDS


@router.post("/v1/qc")
def qc(req: QCRequest):
    import server  # lazy: server imports this module at startup

    src = Path(req.source_audio)
    if not src.is_file():
        raise HTTPException(400, f"source audio not found: {src}")
    out = Path(req.out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".decoded.wav")
    server._run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-vn", "-ac", "1",
                 "-ar", str(server.SAMPLE_RATE), "-c:a", "pcm_s16le", str(tmp)])
    raw, sr = _read_wav(tmp)
    tmp.unlink(missing_ok=True)
    start, end = trim_bounds(raw, sr)
    x = raw[start:end]
    _write_wav(out, x, sr)

    transcript = ""
    if len(x) >= sr * 0.3:
        transcript, _ = server._transcribe(out, req.language)
    metrics = measure(x, sr, req.text, transcript, noise_floor_override=noise_floor_from_edges(raw, sr, start, end))
    # Reverb is measured on the untrimmed decode: trimming removes the decay after the
    # last word, which is exactly the tail the estimator needs.
    rt = reverb_tail_db(raw, sr)
    metrics["reverbTailDb"] = None if rt is None else round(rt, 2)
    verdict, reasons, quality, warnings = judge(metrics)
    server.LOG.info("qc %s: %.2fs verdict=%s %s", out.name, metrics["duration"], verdict,
                    "; ".join(reasons) if reasons else "")
    return {"metrics": metrics, "verdict": verdict, "reasons": reasons, "quality": quality, "warnings": warnings, "thresholds": THRESHOLDS}
