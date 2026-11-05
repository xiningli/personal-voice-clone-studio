"""Measure CosyVoice synthesis speed: whole-sentence vs streaming, with and without TensorRT / vLLM.

One acceleration setting per process (vLLM cannot be torn down and rebuilt cleanly inside
one process), chosen with the same environment variables as the server:

    STUDIO_TTS_MODEL=<model dir> python backend/bench_tts.py --label base --prompt <wav>
    STUDIO_TTS_TRT=1  ... --label trt
    STUDIO_TTS_VLLM=1 ... --label vllm
    STUDIO_TTS_TRT=1 STUDIO_TTS_VLLM=1 ... --label trt+vllm

scripts/bench-tts.sh runs all four. Each synthesis appends one JSON line to --out; the run
ends with a table of medians. Times are wall-clock on the calling thread, so they include the
CPU copy of every chunk, exactly what a client of /v1/tts or /v1/tts/stream waits for.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

SENTENCES = {
    "short": "That is a really good question.",
    "medium": "I built the evaluation environment for the voice agent and logged every single run.",
    "long": ("When the router finds a fitting opener it plays right away, and the answer keeps "
             "going from its last word, so the visitor never hears a gap while the model is still "
             "writing the rest of the reply."),
}
INSTRUCT = "Please speak in a warm and friendly tone."


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--prompt", required=True, help="reference wav (>= 16 kHz)")
    ap.add_argument("--prompt-text", default="", help="transcript of the reference (zero_shot only)")
    ap.add_argument("--mode", default="instruct", choices=["instruct", "zero_shot", "cross_lingual"])
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--out", default="outputs/bench-tts.jsonl")
    ap.add_argument("--save-dir", default="", help="write each sentence's whole-sentence wav here, to check quality")
    args = ap.parse_args()

    import server  # reads STUDIO_TTS_* at import time
    import torch

    engine = server.engine
    engine.load()
    if engine.error:
        raise SystemExit(f"load failed: {engine.error}")
    wav = Path(args.prompt)
    instruct = INSTRUCT if args.mode == "instruct" else ""
    sr = engine.sample_rate
    meta = {
        "label": args.label,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "torch": torch.__version__,
        "accel": engine.accel,
        "load_seconds": engine.load_seconds,
        "mode": args.mode,
    }
    print(json.dumps(meta), flush=True)

    # Where the time goes: wrap the LM job (speech-token generation, runs in its own thread)
    # and token2wav (flow matching + HiFT vocoder) with timers.
    prof = {"llm_s": 0.0, "tokens": 0, "t2w_s": 0.0, "t2w_calls": 0}
    m = engine.model.model
    orig_llm, orig_t2w = m.llm_job, m.token2wav

    def llm_job(*a, **k):
        t0 = time.perf_counter()
        orig_llm(*a, **k)
        prof["llm_s"] += time.perf_counter() - t0
        uid = a[-1] if a else k.get("uuid")
        prof["tokens"] += len(m.tts_speech_token_dict.get(uid, []))

    def token2wav(*a, **k):
        t0 = time.perf_counter()
        out = orig_t2w(*a, **k)
        torch.cuda.synchronize() if torch.cuda.is_available() else None
        prof["t2w_s"] += time.perf_counter() - t0
        prof["t2w_calls"] += 1
        return out

    m.llm_job, m.token2wav = llm_job, token2wav

    def take_prof() -> dict:
        out = {"llm_s": prof["llm_s"], "tokens": prof["tokens"], "t2w_s": prof["t2w_s"], "t2w_calls": prof["t2w_calls"]}
        for k in prof:
            prof[k] = 0 if isinstance(prof[k], int) else 0.0
        out["llm_tok_per_s"] = out["tokens"] / out["llm_s"] if out["llm_s"] else 0.0
        return out

    def whole(text: str) -> dict:
        t0 = time.perf_counter()
        samples, _ = engine.synthesize(text, wav, args.prompt_text, instruct, args.mode, 1.0, seed=7)
        total = time.perf_counter() - t0
        return {"stream": False, "first_chunk_s": total, "total_s": total, "audio_s": len(samples) / sr, **take_prof()}

    def streamed(text: str) -> dict:
        t0 = time.perf_counter()
        first, n, chunks = None, 0, 0
        for chunk in engine.synthesize_stream(text, wav, args.prompt_text, instruct, args.mode, seed=7):
            if first is None:
                first = time.perf_counter() - t0
            n += len(chunk)
            chunks += 1
        total = time.perf_counter() - t0
        return {"stream": True, "first_chunk_s": first, "total_s": total, "audio_s": n / sr, "chunks": chunks, **take_prof()}

    for _ in range(args.warmup):  # CUDA kernels, TensorRT contexts, vLLM's first schedule
        whole(SENTENCES["short"])
        streamed(SENTENCES["short"])
    take_prof()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    if args.save_dir:  # one take per sentence, same seed, for listening and WER checks
        d = Path(args.save_dir) / args.label
        d.mkdir(parents=True, exist_ok=True)
        for name, text in SENTENCES.items():
            samples, _ = engine.synthesize(text, wav, args.prompt_text, instruct, args.mode, 1.0, seed=7)
            (d / f"{name}.wav").write_bytes(server.wav_bytes(samples, sr))
        take_prof()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    with out.open("a") as f:
        for name, text in SENTENCES.items():
            for fn in (whole, streamed):
                for r in range(args.repeats):
                    row = {**meta, "sentence": name, "words": len(text.split()), "repeat": r, **fn(text)}
                    row["rtf"] = row["total_s"] / max(row["audio_s"], 1e-6)
                    rows.append(row)
                    f.write(json.dumps(row) + "\n")
    peak = torch.cuda.max_memory_allocated() / 1024**3 if torch.cuda.is_available() else 0.0

    print(f"\n{args.label} on {meta['gpu']}  accel={engine.accel}  load {engine.load_seconds:.1f}s  peak {peak:.2f} GiB")
    print(f"{'sentence':8} {'words':>5} {'audio s':>7} | {'whole: total':>12} {'rtf':>5} | {'stream: first':>13} {'total':>6} {'rtf':>5} | {'LM tok/s':>8} {'LM s':>5} {'flow+voc s':>10}")
    for name in SENTENCES:
        w = [r for r in rows if r["sentence"] == name and not r["stream"]]
        s = [r for r in rows if r["sentence"] == name and r["stream"]]
        med = lambda xs, k: statistics.median(x[k] for x in xs)
        print(f"{name:8} {w[0]['words']:>5} {med(w, 'audio_s'):>7.2f} | {med(w, 'total_s'):>12.3f} {med(w, 'rtf'):>5.2f} | "
              f"{med(s, 'first_chunk_s'):>13.3f} {med(s, 'total_s'):>6.2f} {med(s, 'rtf'):>5.2f} | "
              f"{med(w, 'llm_tok_per_s'):>8.0f} {med(w, 'llm_s'):>5.2f} {med(w, 't2w_s'):>10.2f}")


if __name__ == "__main__":
    main()
