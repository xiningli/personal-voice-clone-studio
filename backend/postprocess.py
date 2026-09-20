"""Audio post-processing for synthesized lines.

`trim_lead_breath` originates from the author's digital-human TTS backend (same
model): CosyVoice2 continues from the reference's last speech token and its training
data has the speaker draw breath before a continuation, so every line opens with a
short glottal grunt plus ~100 ms of broadband noise. The breath interval is spliced
out up to the first voiced window after it.
"""
from __future__ import annotations

import numpy as np

SAMPLE_RATE = 24_000

VOICED_FRICATIVE_LEADS = (
    "v", "the", "this", "that", "these", "those", "them", "then", "there", "they",
    "though", "thus", "thy", "thence",
)


def starts_with_voiced_fricative(text: str) -> bool:
    lead = text.lstrip(" \t\r\n\"'“”‘’([{-").lower()
    return lead.startswith(VOICED_FRICATIVE_LEADS)


def trim_lead_breath(samples: np.ndarray, text: str, sample_rate: int = SAMPLE_RATE) -> tuple[np.ndarray, int]:
    """Return (samples, trimmed_ms). `samples` is float32 mono in [-1, 1]."""
    window = sample_rate // 100
    limit = min(len(samples) // window, 40)
    if limit < 4:
        return samples, 0
    frames = samples[: limit * window].reshape(limit, window)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(window), axis=1)) ** 2
    high = spectrum[:, 4000 // (sample_rate // window):].sum(axis=1)
    share = high / (spectrum.sum(axis=1) + 1e-12)
    voiced = (share < .25) & (rms > .02)
    breath = next((i for i in range(1, 12) if share[i] > .35 and rms[i] > .006), -1)
    if breath < 1:
        return samples, 0
    onset = next((i for i in range(breath, limit - 2)
                  if voiced[i] and (voiced[i + 1] or voiced[i + 2])), -1)
    if onset < 0:
        if not np.all(share[breath: breath + 5] > .35):
            return samples, 0
        onset = breath
    elif onset - breath > 30:
        return samples, 0
    keep = breath * window if starts_with_voiced_fricative(text) else 0
    cut = onset * window - window // 2
    half = window // 2
    ramp = np.linspace(0.0, 1.0, half, dtype=np.float32)
    rest = samples[cut:].astype(np.float32).copy()
    rest[:half] *= ramp
    if keep:
        stub = samples[:keep].astype(np.float32).copy()
        stub[-half:] *= ramp[::-1]
        out = np.concatenate([stub, rest])
    else:
        out = rest
    return out, int(round((cut - keep) / sample_rate * 1000))
