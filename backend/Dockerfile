# CosyVoice3 TTS backend, self-contained: clones its own CosyVoice checkout, installs the
# serving-only dependency set validated in backend/export.py (the same recipe an exported
# voice bundle uses). CPU by default (STUDIO_FORCE_CPU=1, see docker-compose.yml) for
# portability; set it to 0 and add the GPU device to use a CUDA-capable host.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ffmpeg build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CosyVoice is not on PyPI; clone it and its Matcha-TTS submodule (same as scripts/install-voice.sh).
RUN git clone --depth 1 https://github.com/FunAudioLLM/CosyVoice cosyvoice-repo \
    && git -C cosyvoice-repo submodule update --init --depth 1 third_party/Matcha-TTS

COPY backend/server.py backend/postprocess.py backend/qc.py backend/metrics.py \
     backend/train.py backend/train_tools.py backend/export.py /app/backend/
COPY backend/shims /app/backend/shims

# The serving-only pin set from backend/export.py's REQUIREMENTS_SERVE, written out here so
# a Docker build doesn't need a running studio to generate it.
COPY backend/requirements-docker.txt /app/requirements-docker.txt
# CPU wheels by default: the smallest, most portable image. Override TORCH_INDEX at build
# time (--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu130) for a CUDA image.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch==2.11.0 torchaudio==2.11.0 --index-url "$TORCH_INDEX" \
    && pip install --no-cache-dir -r requirements-docker.txt

ENV STUDIO_COSYVOICE_REPO=/app/cosyvoice-repo \
    STUDIO_MODELS_DIR=/app/models \
    STUDIO_EXPORTS_DIR=/app/exports \
    STUDIO_TTS_HOST=0.0.0.0 \
    STUDIO_TTS_PORT=8010 \
    HF_HOME=/app/.cache/huggingface

EXPOSE 8010
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=20 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8010/health', timeout=3).status==200 else 1)"

CMD ["python", "backend/server.py"]
