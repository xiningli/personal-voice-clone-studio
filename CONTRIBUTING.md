# Contributing

The methodology lives in `docs/protocol.md`; code implements it. A change that alters what
is measured or how (thresholds, trial mix, ranking model, training recipe) must update the
protocol in the same commit and bump the `protocolVersion` written into exports.

- Types first: `lib/types.ts` is the contract between UI, API routes and the backend.
- Backend feature modules (`backend/qc.py`, `backend/metrics.py`, `backend/train.py`) expose
  a FastAPI `router` and reach the engine lazily through `import server`.
- Verify with `npx tsc --noEmit && npx eslint .` and a syntax check of the Python modules.
- Never commit anything under `datasets/`, `models/`, `data/`, `public/audio/` or `certs/`.
  They hold one person's voice and preferences.
- Do not add a dependency on a hosted service. Everything runs on the speaker's machine.
