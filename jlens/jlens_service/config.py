"""Env-driven config for the J-lens sidecar (Tier 2 of the Brain)."""
import os
from pathlib import Path

DEFAULT_LAYERS = "24,32,40,48,56"  # 5 mid layers of ~63 (workspace = middle layers per paper)

def jlens_dir() -> Path:
    return Path(os.environ.get("JLENS_DIR", Path.home() / ".cynco" / "jlens"))

def layers() -> list[int]:
    return sorted({int(x) for x in os.environ.get("JLENS_LAYERS", DEFAULT_LAYERS).split(",") if x.strip()})

def port() -> int:
    return int(os.environ.get("JLENS_PORT", "9163"))

LENS_REPO = "neuronpedia/jacobian-lens"
LENS_FILE = "qwen3.6-27b/jlens/Salesforce-wikitext/Qwen3.6-27B_jacobian_lens_n1000.pt"
MODEL_REPO = os.environ.get("JLENS_MODEL_REPO", "Qwen/Qwen3.6-27B")
