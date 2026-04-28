"""File tree widget -- directory tree wrapper."""
from textual.widgets import DirectoryTree


class FileTree(DirectoryTree):
    """Project file browser."""

    DEFAULT_CSS = """
    FileTree {
        width: 30;
        height: 1fr;
        border: solid $accent;
    }
    """
