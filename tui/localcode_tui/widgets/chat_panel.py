"""Chat panel widget -- streaming message display using RichLog."""
from textual.widgets import RichLog
from rich.text import Text
from rich.markdown import Markdown


class ChatPanel(RichLog):
    """Streaming chat display. Renders assistant responses as Markdown."""

    can_focus = False  # Keep focus on the Input widget

    DEFAULT_CSS = """
    ChatPanel {
        border: solid $accent;
        height: 1fr;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, markup=True, wrap=True, **kwargs)
        self._streaming_text = ""
        self._streaming = False
        self._pre_stream_count = 0
        self._last_response = ""
        self._token_count = 0

    def add_user_message(self, text: str) -> None:
        self._finish_streaming()
        self.write(f"[bold cyan]You:[/bold cyan] {text}")

    def add_assistant_token(self, text: str) -> None:
        """Append streaming token to current assistant message."""
        if not self._streaming:
            self._streaming = True
            self._streaming_text = ""
            self._pre_stream_count = len(self.lines)
            self._token_count = 0

        self._streaming_text += text
        self._token_count += 1

        # Re-render the entire streaming block periodically.
        # Every 5 tokens or on newlines — avoids per-token churn
        # which causes duplicate lines when RichLog wraps long text.
        if self._token_count % 5 == 0 or '\n' in text:
            # Remove all streaming lines
            while len(self.lines) > self._pre_stream_count:
                self.lines.pop()
            # Re-render the full streaming text as plain text lines
            for line in self._streaming_text.split('\n'):
                self.write(Text(line))
            self.scroll_end(animate=False)

    def finish_streaming(self) -> None:
        """Finalize the streamed message, render as markdown."""
        self._finish_streaming()

    def _finish_streaming(self) -> None:
        if self._streaming and self._streaming_text:
            self._last_response = self._streaming_text  # Save for /copy
            # Remove all streaming lines
            while len(self.lines) > self._pre_stream_count:
                self.lines.pop()
            # Write final rendered markdown (proper wrapping, formatting)
            self.write(Markdown(self._streaming_text))
            self.scroll_end(animate=False)
        self._streaming_text = ""
        self._token_count = 0
        self._streaming = False

    def complete_assistant_message(self, full_text: str) -> None:
        """Replace streaming tokens with properly rendered markdown."""
        self._streaming_text = full_text or self._streaming_text
        self._finish_streaming()

    def add_system_message(self, text: str) -> None:
        self._finish_streaming()
        self.write(f"[dim]{text}[/dim]")

    def add_error(self, text: str) -> None:
        self._finish_streaming()
        self.write(f"[bold red]Error:[/bold red] {text}")

    def get_last_response(self) -> str:
        """Return the text of the last assistant response for clipboard copy."""
        return self._last_response or ""
