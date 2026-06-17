"""Hidden scoring test (never shown to the agent).

Targets ProductionPopup._build_queue_html in production.py. The queue
display renders a 200-cell progress bar for the city's current build:
fraction = production / cost, the bar shows int(200 * fraction) filled
'#' cells followed by '.' cells, plus an integer percent. The fraction
MUST be clamped to 1.0 so an over-funded item (production > cost, e.g.
carryover/overflow) renders a full 200-'#' bar at 100% and never spills
past the bar width or above 100%. No randomness on the asserted path.
"""
from production import ProductionPopup


class _FakeCity:
    """Minimal duck-typed city stub for headless queue rendering."""

    def __init__(self, production, cost, current="Granary"):
        self.name = "Rome"
        self.current_production = current
        self.production = production
        self.production_queue = []
        self.production_capacity = 5
        self._cost = cost

    def get_production_cost(self, item):
        return self._cost


def _bar_segment(html):
    # The bar is the bracketed run: [###...]  -> return inner text.
    start = html.index("[")
    end = html.index("]", start)
    return html[start + 1:end]


def test_midprogress_bar_is_half_filled():
    popup = ProductionPopup()
    html = popup._build_queue_html(_FakeCity(production=30, cost=60))
    bar = _bar_segment(html)
    # 30/60 = 0.5 -> int(200 * 0.5) = 100 filled, 100 empty.
    assert bar.count("#") == 100
    assert bar.count(".") == 100
    assert len(bar) == 200
    assert "50%" in html


def test_overflow_production_clamps_to_full_bar():
    popup = ProductionPopup()
    # Over-funded: 90 production vs 60 cost -> fraction 1.5, must clamp.
    html = popup._build_queue_html(_FakeCity(production=90, cost=60))
    bar = _bar_segment(html)
    assert bar.count("#") == 200
    assert bar.count(".") == 0
    assert len(bar) == 200
    assert "100%" in html
    # Never reports a percent above 100.
    assert "150%" not in html
