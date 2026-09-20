"""Minimal stand-in for the `deepspeed` package.

CosyVoice's train.py / train_utils.py import deepspeed unconditionally even when
`--train_engine torch_ddp` is used. The real package is not installed in the shared venv,
so backend/train.py puts this directory on PYTHONPATH for training subprocesses only when
`import deepspeed` fails. Every entry point that torch_ddp never reaches raises.
"""


def add_config_arguments(parser):
    parser.add_argument("--deepspeed", action="store_true", default=False, help="(shim) unused")
    parser.add_argument("--deepspeed_config", default=None, type=str, help="(shim) unused")
    parser.add_argument("--deepscale", action="store_true", default=False, help="(shim) unused")
    parser.add_argument("--deepscale_config", default=None, type=str, help="(shim) unused")
    return parser


def init_distributed(*args, **kwargs):
    raise RuntimeError("deepspeed shim: --train_engine deepspeed is not available; use torch_ddp")


def initialize(*args, **kwargs):
    raise RuntimeError("deepspeed shim: --train_engine deepspeed is not available; use torch_ddp")
