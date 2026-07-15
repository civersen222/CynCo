from localcode_tui.screens.vibe_loop import VibeLoopScreen


def test_vibe_screen_has_copy_handler():
    assert hasattr(VibeLoopScreen, "action_copy") or hasattr(VibeLoopScreen, "_handle_copy")
