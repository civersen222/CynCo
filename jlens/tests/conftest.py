"""Shared synthetic Readout builder (d=8, vocab=16 — no artifacts in CI).
torch is optional: a test that needs a Readout skips without it, so the
server's own tests (no tensors) still run where only the service code is."""
import pytest

try:
    import torch
    from jlens_service.readout import Readout
except ImportError:  # no torch: make_readout skips its caller
    torch = None
    Readout = None


def make_readout(d=8, vocab=16):
    if torch is None:
        pytest.skip("torch is not installed")
    torch.manual_seed(0)
    r = Readout.__new__(Readout)
    r.J = {2: torch.eye(d, dtype=torch.float32)}
    r.wu = torch.randn(vocab, d)
    r.norm_w = torch.ones(d)
    r.id_to_token = {i: f"tok{i}" for i in range(vocab)}
    return r
