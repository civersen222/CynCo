"""Shared synthetic Readout builder (d=8, vocab=16 — no artifacts in CI).
torch is optional: a test that needs a Readout skips without it, so the
server's own tests (no tensors) still run where only the service code is."""
import pytest

# torch and the service's readout module are imported apart, so that each
# failure is named for what it is. Under one `except ImportError` a broken
# jlens_service.readout was reported as "torch is not installed".
try:
    import torch
    TORCH_MISSING = None
except ImportError as e:  # no torch: make_readout skips its caller, and says so
    torch = None
    TORCH_MISSING = f"torch is not installed ({e})"

Readout = None
READOUT_BROKEN = None
if torch is not None:
    try:
        from jlens_service.readout import Readout
    except ImportError as e:
        # torch is here, so this is the service's own code failing to import:
        # a defect to fail on in make_readout, not a missing optional package.
        READOUT_BROKEN = f"jlens_service.readout failed to import with torch present: {e!r}"


def make_readout(d=8, vocab=16):
    if TORCH_MISSING is not None:
        pytest.skip(TORCH_MISSING)
    if READOUT_BROKEN is not None:
        pytest.fail(READOUT_BROKEN)
    torch.manual_seed(0)
    r = Readout.__new__(Readout)
    r.J = {2: torch.eye(d, dtype=torch.float32)}
    r.wu = torch.randn(vocab, d)
    r.norm_w = torch.ones(d)
    r.id_to_token = {i: f"tok{i}" for i in range(vocab)}
    return r
