#!/usr/bin/env python3
"""Data-preparation helpers for fine-tuning, run as subprocesses by backend/train.py.

    train_tools.py prepare-sft  --takes datasets/<spk>/takes.jsonl --repo-root . --out <work>/data
                                --speaker owner --heldout 0.05 --seed 1234
    train_tools.py prepare-dpo  --pairs <pairs.jsonl> --repo-root . --out <work>/data --profiles data/voice-profiles.json
    train_tools.py embeddings   --dir <data/train> --onnx <base>/campplus.onnx [--wav-scp other.scp]
    train_tools.py tokens       --dir <data/train> --onnx <base>/speech_tokenizer_v3.onnx --provider cpu|cuda

Each `--dir` is a Kaldi-style directory (wav.scp, text, utt2spk, spk2utt, instruct) that the
vendored tools/make_parquet_list.py then turns into parquet shards. `embeddings` and `tokens`
re-implement tools/extract_embedding.py and tools/extract_speech_token.py so the execution
provider can be chosen (the vendored token extractor hard-codes CUDA) and so an embedding can
be taken from a different wav than the training target (DPO uses the profile prompt).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
import sys
from pathlib import Path

LOG = logging.getLogger("studio.train_tools")
INSTRUCT = "You are a helpful assistant.<|endofprompt|>"


# ---------- Kaldi-dir helpers ----------

def write_kaldi_dir(out: Path, utts: list[dict]) -> None:
    """utts: [{utt, wav, text, spk, instruct?}] -> wav.scp/text/utt2spk/spk2utt/instruct.

    `instruct` (optional per utt) is the natural-language instruction the sample was made
    with; it is written in the same "You are a helpful assistant. <instruct><|endofprompt|>"
    form the inference path uses, so training and inference share one prompt format."""
    out.mkdir(parents=True, exist_ok=True)
    spk2utt: dict[str, list[str]] = {}
    with open(out / "wav.scp", "w") as fw, open(out / "text", "w") as ft, \
            open(out / "utt2spk", "w") as fs, open(out / "instruct", "w") as fi:
        for u in utts:
            text = " ".join(u["text"].split())
            fw.write(f"{u['utt']} {u['wav']}\n")
            ft.write(f"{u['utt']} {text}\n")
            fs.write(f"{u['utt']} {u['spk']}\n")
            ins = (u.get("instruct") or "").strip()
            fi.write(f"{u['utt']} {('You are a helpful assistant. ' + ins + '<|endofprompt|>') if ins else INSTRUCT}\n")
            spk2utt.setdefault(u["spk"], []).append(u["utt"])
    with open(out / "spk2utt", "w") as f:
        for spk, lst in spk2utt.items():
            f.write(f"{spk} {' '.join(lst)}\n")


def read_scp(path: Path) -> dict[str, str]:
    d = {}
    with open(path) as f:
        for line in f:
            parts = line.rstrip("\n").split(maxsplit=1)
            if len(parts) == 2:
                d[parts[0]] = parts[1]
    return d


def resolve(repo_root: Path, p: str) -> Path:
    # Arena / profile paths are public URLs like /audio/arena/x.wav (they look absolute).
    if p.startswith("/audio/"):
        return repo_root / "public" / p.lstrip("/")
    q = Path(p)
    if q.is_absolute():
        return q
    return repo_root / p


# ---------- prepare-sft ----------

def prepare_sft(args: argparse.Namespace) -> None:
    repo_root = Path(args.repo_root).resolve()
    takes = [json.loads(l) for l in open(args.takes) if l.strip()]
    accepted = [t for t in takes if t.get("verdict") == "accept"]
    if not args.include_borderline:
        accepted = [t for t in accepted if t.get("quality", "clean") != "borderline"]
    if not accepted:
        raise SystemExit("no usable takes in " + args.takes + " (clean only unless --include-borderline)")
    # Held-out split by sentence id (promptId) so no sentence appears on both sides.
    sentence_ids = sorted({t["promptId"] for t in accepted})
    rng = random.Random(args.seed)
    rng.shuffle(sentence_ids)
    n_dev = max(1, int(round(len(sentence_ids) * args.heldout))) if len(sentence_ids) > 1 else 0
    dev_ids = set(sentence_ids[:n_dev])
    train, dev = [], []
    for t in accepted:
        wav = resolve(repo_root, t["audioPath"])
        if not wav.is_file():
            LOG.warning("missing wav for take %s: %s", t["id"], wav)
            continue
        utt = f"{args.speaker}_{t['id']}"
        rec = {"utt": utt, "wav": str(wav), "text": t["text"], "spk": args.speaker}
        (dev if t["promptId"] in dev_ids else train).append(rec)
    if not train:
        raise SystemExit("no training utterances after split")
    if not dev:  # keep cv non-empty; train.py runs cv every epoch
        dev = train[:1]
    out = Path(args.out)
    write_kaldi_dir(out / "train", train)
    write_kaldi_dir(out / "dev", dev)
    seconds = sum(float(t["metrics"].get("duration", 0)) for t in accepted)
    summary = {
        "accepted_takes": len(accepted), "train_utts": len(train), "dev_utts": len(dev),
        "accepted_seconds": round(seconds, 1), "heldout_sentences": sorted(dev_ids),
        "emotions": sorted({t.get("emotion", "neutral") for t in accepted}),
        "include_borderline": bool(args.include_borderline),
        "borderline_takes": sum(1 for t in accepted if t.get("quality") == "borderline"),
    }
    json.dump(summary, open(out / "summary.json", "w"), indent=2)
    print(json.dumps(summary))


# ---------- prepare-dpo ----------

def prepare_dpo(args: argparse.Namespace) -> None:
    repo_root = Path(args.repo_root).resolve()
    pairs = [json.loads(l) for l in open(args.pairs) if l.strip()]
    profiles = {p["id"]: p for p in json.load(open(args.profiles))}
    chosen, rejected, prompts = [], [], []
    skipped = 0
    mixed = 0
    for i, p in enumerate(pairs):
        prof = profiles.get(p.get("profileId"))
        c = resolve(repo_root, p["chosen"]["audioPath"])
        r = resolve(repo_root, p["rejected"]["audioPath"])
        if not prof or not prof.get("promptAudioPath") or not c.is_file() or not r.is_file():
            skipped += 1
            continue
        # DPO compares two responses to the SAME prompt (text + instruction). A pair whose
        # sides were made with different instructions is an instruction preference, not a
        # sample preference, and is dropped unless --allow-mixed-instruct is given.
        ins_c = (p["chosen"].get("instruct") or "").strip()
        ins_r = (p["rejected"].get("instruct") or "").strip()
        if ins_c != ins_r and not args.allow_mixed_instruct:
            mixed += 1
            continue
        utt = f"pair_{i:06d}_{hashlib.sha1(p['roundId'].encode()).hexdigest()[:8]}"
        spk = f"profile_{prof['id'][:8]}"
        chosen.append({"utt": utt, "wav": str(c), "text": p["text"], "spk": spk, "instruct": ins_c})
        rejected.append({"utt": utt, "wav": str(r), "text": p["text"], "spk": spk, "instruct": ins_c})
        prompts.append({"utt": utt, "wav": str(resolve(repo_root, prof["promptAudioPath"])), "text": "", "spk": spk})
    if not chosen:
        raise SystemExit("no usable pairs (audio or profile prompt missing)")
    out = Path(args.out)
    # train.py's cv loop needs a dev list; hold out a few pairs by index with a fixed seed.
    rng = random.Random(args.seed)
    idx = list(range(len(chosen)))
    rng.shuffle(idx)
    n_dev = max(1, int(round(len(idx) * args.heldout))) if len(idx) > 4 else 1
    dev_idx = set(idx[:n_dev])
    for split, keep in (("train", lambda k: k not in dev_idx), ("dev", lambda k: k in dev_idx)):
        sel = [k for k in range(len(chosen)) if keep(k)] or [0]
        write_kaldi_dir(out / split, [chosen[k] for k in sel])
        write_kaldi_dir(out / f"{split}_reject", [rejected[k] for k in sel])
        # Embedding source: the profile prompt, not the synthesized wav.
        with open(out / split / "prompt_wav.scp", "w") as f:
            for k in sel:
                f.write(f"{prompts[k]['utt']} {prompts[k]['wav']}\n")
    summary = {"pairs": len(pairs), "usable": len(chosen), "skipped": skipped, "mixed_instruct_dropped": mixed, "dev": len(dev_idx)}
    json.dump(summary, open(out / "summary.json", "w"), indent=2)
    print(json.dumps(summary))


# ---------- embeddings / tokens ----------

def _session(onnx: str, provider: str):
    import onnxruntime
    opt = onnxruntime.SessionOptions()
    opt.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    opt.intra_op_num_threads = 1
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if provider == "cuda" else ["CPUExecutionProvider"]
    return onnxruntime.InferenceSession(onnx, sess_options=opt, providers=providers)


def _load16k(path: str):
    import torchaudio
    audio, sr = torchaudio.load(path, backend="soundfile")
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)
    if sr != 16000:
        audio = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(audio)
    return audio


def embeddings(args: argparse.Namespace) -> None:
    import torch
    import torchaudio.compliance.kaldi as kaldi
    d = Path(args.dir)
    utt2wav = read_scp(Path(args.wav_scp) if args.wav_scp else d / "wav.scp")
    utt2spk = read_scp(d / "utt2spk")
    sess = _session(args.onnx, "cpu")
    utt2emb, spk2emb = {}, {}
    for utt, wav in utt2wav.items():
        feat = kaldi.fbank(_load16k(wav), num_mel_bins=80, dither=0, sample_frequency=16000)
        feat = feat - feat.mean(dim=0, keepdim=True)
        emb = sess.run(None, {sess.get_inputs()[0].name: feat.unsqueeze(0).numpy()})[0].flatten().tolist()
        utt2emb[utt] = emb
        spk2emb.setdefault(utt2spk.get(utt, "spk"), []).append(emb)
    for k, v in spk2emb.items():
        spk2emb[k] = torch.tensor(v).mean(dim=0).tolist()
    torch.save(utt2emb, d / "utt2embedding.pt")
    torch.save(spk2emb, d / "spk2embedding.pt")
    print(json.dumps({"utts": len(utt2emb), "spks": len(spk2emb)}))


def tokens(args: argparse.Namespace) -> None:
    import numpy as np
    import torch
    import whisper
    d = Path(args.dir)
    utt2wav = read_scp(d / "wav.scp")
    sess = _session(args.onnx, args.provider)
    out = {}
    too_long = 0
    for utt, wav in utt2wav.items():
        audio = _load16k(wav)
        if audio.shape[1] / 16000 > 30:
            too_long += 1
            out[utt] = []
            continue
        feat = whisper.log_mel_spectrogram(audio, n_mels=128)
        out[utt] = sess.run(None, {sess.get_inputs()[0].name: feat.numpy(),
                                   sess.get_inputs()[1].name: np.array([feat.shape[2]], dtype=np.int32)})[0].flatten().tolist()
    torch.save(out, d / "utt2speech_token.pt")
    print(json.dumps({"utts": len(out), "too_long": too_long}))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("prepare-sft")
    s.add_argument("--takes", required=True); s.add_argument("--repo-root", required=True); s.add_argument("--out", required=True)
    s.add_argument("--speaker", default="owner"); s.add_argument("--heldout", type=float, default=0.05); s.add_argument("--seed", type=int, default=1234)
    s.add_argument("--include-borderline", action="store_true")
    s.set_defaults(fn=prepare_sft)
    s = sub.add_parser("prepare-dpo")
    s.add_argument("--pairs", required=True); s.add_argument("--repo-root", required=True); s.add_argument("--out", required=True)
    s.add_argument("--profiles", required=True); s.add_argument("--heldout", type=float, default=0.05); s.add_argument("--seed", type=int, default=1234)
    s.add_argument("--allow-mixed-instruct", action="store_true")
    s.set_defaults(fn=prepare_dpo)
    s = sub.add_parser("embeddings")
    s.add_argument("--dir", required=True); s.add_argument("--onnx", required=True); s.add_argument("--wav-scp", default=None)
    s.set_defaults(fn=embeddings)
    s = sub.add_parser("tokens")
    s.add_argument("--dir", required=True); s.add_argument("--onnx", required=True); s.add_argument("--provider", default="cpu", choices=["cpu", "cuda"])
    s.set_defaults(fn=tokens)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
