"""Hidden scoring test (never shown to the agent).

Verifies the worker-gated build progression in ImprovementManager.process_turn:
an active improvement must only advance when a Worker occupies its tile, and it
must complete (progress -> -1, removed from active set) after exactly
``build_turns`` worker-turns. Asserted path is fully deterministic and headless.
"""
from game_data import TerrainType
from hex_map import HexTile
from improvements import ImprovementManager


def _active_tile():
    """A tile with a Farm under construction at turn 0 (bypasses can_improve)."""
    tile = HexTile(2, 3, TerrainType.PLAINS)
    tile.improvement = 'Farm'
    tile.improvement_progress = 0
    return tile


def test_no_progress_without_worker():
    mgr = ImprovementManager()
    tile = _active_tile()
    all_tiles = {(2, 3): tile}
    mgr._active_improvements[(2, 3)] = 'Farm'

    # No worker present across many turns: nothing advances, stays active.
    for _ in range(5):
        mgr.process_turn(set(), all_tiles)

    assert tile.improvement_progress == 0
    assert (2, 3) in mgr._active_improvements


def test_worker_advances_and_completes_at_build_turns():
    mgr = ImprovementManager()
    tile = _active_tile()
    all_tiles = {(2, 3): tile}
    mgr._active_improvements[(2, 3)] = 'Farm'  # Farm build_turns == 3
    workers = {(2, 3)}

    mgr.process_turn(workers, all_tiles)
    assert tile.improvement_progress == 1

    mgr.process_turn(workers, all_tiles)
    assert tile.improvement_progress == 2

    msgs = mgr.process_turn(workers, all_tiles)
    # Completed: progress flips to -1 and the entry is dropped from active set.
    assert tile.improvement_progress == -1
    assert (2, 3) not in mgr._active_improvements
    assert any('Farm' in m for m in msgs)


def test_worker_elsewhere_does_not_advance():
    mgr = ImprovementManager()
    tile = _active_tile()
    all_tiles = {(2, 3): tile}
    mgr._active_improvements[(2, 3)] = 'Farm'

    # Worker on a different tile must not advance this improvement.
    for _ in range(5):
        mgr.process_turn({(9, 9)}, all_tiles)

    assert tile.improvement_progress == 0
    assert (2, 3) in mgr._active_improvements
