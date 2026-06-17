# trade-route-income

- **Source:** authored (derived from the real economy tests
  `test_economy_systems.py::TestTradeRoutes::test_trade_routes` and
  `::test_multiple_trade_routes`). The trivially-passing `test_trade_route_tick`
  was rejected as too weak — it only checks a counter increments and requires no
  real implementation work.
- **Start ref:** 03b4032 (known-green CivKings HEAD on 2026-06-16).
- **setup.patch** removes the per-route gold crediting from
  `EconomyManager.process_trade_routes` (drops `total_gold += route.gold_per_turn`
  and the `add_gold` call) while leaving `route.tick()` intact, so there is real,
  scoped work to do: restore the income.
- **hidden_test.py** asserts that processing routes credits `gold_per_turn` to the
  economy (single + multiple routes). Pass = pytest exit 0. Never copied into the
  workdir until scoring time.
- **Gold fix (for the FAIL→PASS validation gate):**
  `git checkout 03b4032 -- economy.py`.
- **Difficulty:** single subsystem (economy), multi-file lookup (test references
  `EconomyManager` + `TradeRoute`; the income loop lives in `economy.py`).
