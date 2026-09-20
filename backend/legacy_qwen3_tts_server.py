"""
FastAPI server wrapping Qwen3-TTS for voice cloning.
Serves POST /v1/tts — expected by personal-voice-clone-studio.
"""

import io
import os
import time
import torch
import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional

app = FastAPI()

# Lazy-load model on first request
_model = None


def get_model():
    global _model
    if _model is None:
        from qwen_tts import Qwen3TTSModel

        print("Loading Qwen3-TTS-12Hz-1.7B-Base model...")
        _model = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            device_map="cuda:0",
            dtype=torch.bfloat16,
        )
        print("Model loaded.")
    return _model


class TTSRequest(BaseModel):
    text: str
    reference_audio: str
    speed: float = 1.0
    pitch: float = 1.0
    emotion_prompt: str = ""
    format: str = "wav"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/tts")
def generate_tts(req: TTSRequest):
    import traceback
    try:
        model = get_model()

        print(f"Request: text={req.text[:80]}..., ref={req.reference_audio}")
        if not os.path.exists(req.reference_audio):
            return Response(
                content=f"Reference audio not found: {req.reference_audio}",
                status_code=400,
            )

        t0 = time.time()
        wavs, sr = model.generate_voice_clone(
            text=req.text,
            language="English",
            ref_audio=req.reference_audio,
            x_vector_only_mode=True,
        )
        elapsed = time.time() - t0
        print(f"Generated {len(wavs[0]) / sr:.1f}s audio in {elapsed:.1f}s")

        audio = wavs[0]

        # Apply speed adjustment if not 1.0
        if req.speed != 1.0 and req.speed > 0:
            import librosa
            audio = librosa.effects.time_stretch(audio, rate=req.speed)

        duration = len(audio) / sr

        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV")
        buf.seek(0)

        return Response(
            content=buf.read(),
            media_type="audio/wav",
            headers={"x-audio-duration": str(round(duration, 2))},
        )
    except Exception as e:
        traceback.print_exc()
        return Response(content=str(e), status_code=500)


if __name__ == "__main__":
    import uvicorn
    # Pre-load model at startup
    get_model()
    uvicorn.run(app, host="0.0.0.0", port=8000)
