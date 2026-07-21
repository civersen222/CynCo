"""J-lens readout: softmax(W_U · rmsnorm(J_l · h)).
Two-step matvec on purpose — folding W_U·J is mathematically invalid because
the RMSNorm sits between them (research report §4)."""
import torch
from . import config


def rms_norm(x: torch.Tensor, weight: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    return x / torch.sqrt(x.pow(2).mean(-1, keepdim=True) + eps) * weight


class Readout:
    def __init__(self) -> None:
        d = config.jlens_dir()
        self.J = {l: torch.load(d / "layers" / f"{l}.pt", map_location="cpu", weights_only=False).float()
                  for l in config.layers()}
        self.wu = torch.load(d / "wu.pt", map_location="cpu", weights_only=False).float()
        self.norm_w = torch.load(d / "norm.pt", map_location="cpu", weights_only=False).float()
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(config.MODEL_REPO)
        self.id_to_token = {i: tok.decode([i]) for i in range(self.wu.shape[0])}

    def readout(self, layer: int, h: torch.Tensor, k: int = 25) -> list[tuple[str, float]]:
        v = self.J[layer] @ h.float()          # raises KeyError for unknown layer (intended)
        logits = self.wu @ rms_norm(v, self.norm_w)
        p = torch.softmax(logits, -1)
        top = torch.topk(p, k)
        return [(self.id_to_token.get(int(i), f"<{int(i)}>"), float(pv))
                for i, pv in zip(top.indices, top.values)]
