"""Download + slice the precomputed Qwen3.6-27B Jacobian lens and the model's
unembedding (W_U) + final norm. Run once:  python -m jlens_service.download
Artifacts land in ~/.cynco/jlens/ (env JLENS_DIR)."""
import json
import torch
from huggingface_hub import hf_hub_download
from safetensors import safe_open
from . import config


def fetch_lens() -> None:
    out = config.jlens_dir() / "layers"
    out.mkdir(parents=True, exist_ok=True)
    # Skip if all layer files already exist
    target_layers = config.layers()
    if all((out / f"{l}.pt").exists() for l in target_layers):
        print(f"lens layers already present: {target_layers}, skipping download")
        return
    path = hf_hub_download(config.LENS_REPO, config.LENS_FILE)
    blob = torch.load(path, map_location="cpu", weights_only=False)
    # Keys may be str or int depending on how the artifact was serialised
    raw_keys = list(blob["J"].keys())
    print(f"lens raw key type: {type(raw_keys[0])}, sample: {raw_keys[:3]}")
    J = {int(k): v for k, v in blob["J"].items()}
    available = sorted(J.keys())
    print(f"lens: d_model={blob['d_model']} n_prompts={blob['n_prompts']} layers={available[:3]}...{available[-3:]}")
    for l in target_layers:
        if l not in J:
            raise SystemExit(f"layer {l} not in artifact (has {available})")
        torch.save(J[l].to(torch.float16), out / f"{l}.pt")
        print(f"saved layer {l}: {tuple(J[l].shape)}")


def fetch_unembed() -> None:
    out = config.jlens_dir()
    index_path = hf_hub_download(config.MODEL_REPO, "model.safetensors.index.json")
    index = json.loads(open(index_path).read())["weight_map"]
    # Qwen3.6-27B VL uses lm_head.weight (not tied to embed_tokens); VL model has
    # model.language_model.norm.weight as the final norm (not model.norm.weight).
    lm_head_candidates = ["lm_head.weight", "model.embed_tokens.weight", "model.language_model.embed_tokens.weight"]
    lm_head = next((k for k in lm_head_candidates if k in index), None)
    if lm_head is None:
        raise SystemExit(f"Could not find lm_head weight in index. Keys sample: {list(index.keys())[:10]}")
    if lm_head != "lm_head.weight":
        print(f"lm_head.weight not in index — using tied fallback: {lm_head}")

    norm_candidates = ["model.norm.weight", "model.language_model.norm.weight"]
    norm = next((k for k in norm_candidates if k in index), None)
    if norm is None:
        raise SystemExit(f"Could not find final norm weight in index. Keys sample: {list(index.keys())[:10]}")
    if norm != "model.norm.weight":
        print(f"model.norm.weight not in index — using VL fallback: {norm}")

    for name, dest in [(lm_head, "wu.pt"), (norm, "norm.pt")]:
        dest_path = out / dest
        if dest_path.exists():
            print(f"{dest} already exists, skipping")
            continue
        shard = hf_hub_download(config.MODEL_REPO, index[name])
        with safe_open(shard, framework="pt") as f:
            torch.save(f.get_tensor(name).to(torch.float16), dest_path)
            print(f"saved {name} -> {dest}")


if __name__ == "__main__":
    fetch_lens()
    fetch_unembed()
