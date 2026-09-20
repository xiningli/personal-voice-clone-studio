# Local environment overrides — copy to scripts/local-env.sh (git-ignored) and edit.
# Sourced by backend/run.sh and the scripts/* helpers before defaults are applied.

# Interpreter with torch + CosyVoice deps for the backend.
#export STUDIO_PYTHON=/path/to/.venv/bin/python

# Vendored CosyVoice checkout (must contain cosyvoice/).
#export STUDIO_COSYVOICE_REPO=/path/to/models/CosyVoice

# Backend port / model overrides (see README's environment table for the full list).
#export STUDIO_TTS_PORT=8010
#export STUDIO_TTS_MODEL=FunAudioLLM/Fun-CosyVoice3-0.5B-2512
