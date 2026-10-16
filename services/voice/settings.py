"""Reads the repo config the same way the Node services do: config/default.json overridden by config/local.json.
Objects merge key by key; arrays and scalars are replaced. Standard library only, so it can be tested anywhere."""
import json, os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

def merge(base, over):
    if isinstance(base, dict) and isinstance(over, dict):
        return {**base, **{k: merge(base.get(k), v) for k, v in over.items()}}
    return over

def load_config(config_dir=None):
    d = Path(config_dir or os.environ.get("CC_CONFIG_DIR") or REPO / "config")
    cfg = json.loads((d / "default.json").read_text())
    local = d / "local.json"
    return merge(cfg, json.loads(local.read_text())) if local.exists() else cfg

def run_dir():
    return Path(os.environ.get("CC_RUN_DIR") or REPO / "run")

def pick_engine(kind, cfg, audio_seconds=0.0):
    """STT 'auto': short recordings (commands) go to the local model, long dictation to the cloud one."""
    e = cfg[kind]["engine"]
    if kind == "stt" and e == "auto":
        r = cfg["stt"]["route_by_length"]
        return r["short"] if audio_seconds < r["threshold_s"] else r["long"]
    return e

def engine_order(kind, cfg, first, forced=False):
    """The engine to try first, then the other one if fallback is on and the caller did not force an engine."""
    return [first] + ([e for e in ("local", "cloud") if e != first] if cfg[kind].get("fallback") and not forced else [])
