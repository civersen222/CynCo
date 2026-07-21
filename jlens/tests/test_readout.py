import torch

from conftest import make_readout

def test_topk_shape_and_order():
    r = make_readout()
    top = r.readout(2, torch.randn(8), k=5)
    assert len(top) == 5
    assert all(top[i][1] >= top[i + 1][1] for i in range(4))          # descending p
    assert all(isinstance(t, str) and 0 <= p <= 1 for t, p in top)

def test_identity_J_peaks_on_aligned_token():
    r = make_readout()
    # h aligned with W_U row 3 -> token 3 should win under identity transport
    h = r.wu[3].clone()
    assert r.readout(2, h, k=1)[0][0] == "tok3"

def test_unknown_layer_raises():
    r = make_readout()
    try:
        r.readout(99, torch.randn(8))
        assert False
    except KeyError:
        pass
