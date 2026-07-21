"""Shared synthetic Readout builder (d=8, vocab=16 — no artifacts in CI)."""
import torch

from jlens_service.readout import Readout


def make_readout(d=8, vocab=16):
    torch.manual_seed(0)
    r = Readout.__new__(Readout)
    r.J = {2: torch.eye(d, dtype=torch.float32)}
    r.wu = torch.randn(vocab, d)
    r.norm_w = torch.ones(d)
    r.id_to_token = {i: f"tok{i}" for i in range(vocab)}
    return r
