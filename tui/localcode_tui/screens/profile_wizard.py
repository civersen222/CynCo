"""Profile-building wizard — guided profile creation for non-engineers.

An 8-step modal wizard that walks users through creating a LocalCode profile
in plain language. LLM-assisted steps use the engine for natural language
interpretation, with scripted fallbacks for timeout/failure.

Steps:
  1. Pick use case (Coding/Writing/Chat/Custom)
  2. Pick expertise level (beginner/intermediate/advanced)
  3. Describe ideal behavior -> system prompt (NL + LLM)
  4. Pick base model from installed list
  5. Describe tool needs -> allowed/denied (NL + LLM)
  6. Tune temperature/tokens/context (sliders with explained defaults)
  7. Preview generated YAML
  8. Name + validate + save

Design philosophy: explain what/why/when at every step (antivibe approach).
Never assume the user knows what "temperature" or "tool scoping" means.
"""
from __future__ import annotations
import json
from textual.screen import ModalScreen
from textual.containers import Vertical, Horizontal
from textual.widgets import Static, Button, Input, OptionList
from textual.widgets.option_list import Option

from .profile_wizard_presets import (
    USE_CASES, get_preset, WizardState, generate_profile_yaml,
)
from .model_picker import fetch_local_models


STEP_COUNT = 8

# --- Explanation text for each step ----------------------------------------

STEP_EXPLANATIONS = {
    0: (
        "[bold]What do you want to use LocalCode for?[/bold]\n\n"
        "Pick the option that best describes what you'll be doing. "
        "This sets sensible defaults so you don't have to configure everything manually.\n\n"
        "[dim]Don't worry -- you can change any of these later in Settings.[/dim]"
    ),
    1: (
        "[bold]How comfortable are you with coding?[/bold]\n\n"
        "This helps LocalCode adjust how much guidance and explanation it gives you.\n\n"
        "  [bold]New to coding[/bold] — full guidance, explanations after every action, "
        "safety guardrails that prevent risky operations\n\n"
        "  [bold]Can read code[/bold] — explanations available but not forced, "
        "warnings about risky actions but no blocking\n\n"
        "  [bold]Experienced developer[/bold] — pure terminal, no guardrails, "
        "no automatic explanations\n\n"
        "[dim]You can change this anytime in Settings.[/dim]"
    ),
    2: (
        "[bold]How should your AI behave?[/bold]\n\n"
        "Describe in your own words what you want. For example:\n"
        "  [dim]'Be concise, always explain what you changed, ask before deleting files'[/dim]\n\n"
        "The AI will turn your description into instructions it can follow.\n"
        "[dim]If you're not sure, just press Next to use the default for your use case.[/dim]"
    ),
    3: (
        "[bold]Which AI model should power this profile?[/bold]\n\n"
        "These are the models installed on your computer via Ollama. "
        "Bigger models (more GB) are smarter but slower.\n\n"
        "[dim]If you're not sure, pick the largest model that fits your GPU.[/dim]"
    ),
    4: (
        "[bold]What tools should the AI be able to use?[/bold]\n\n"
        "Tools let the AI do things beyond just chatting -- like reading files, "
        "editing code, or running commands in the terminal.\n\n"
        "Describe what you're comfortable with, e.g.:\n"
        "  [dim]'It can read and edit files but I don't want it running terminal commands'[/dim]\n\n"
        "[dim]Press Next to use the defaults for your use case.[/dim]"
    ),
    5: (
        "[bold]Fine-tune the AI's behavior[/bold]\n\n"
        "[bold]Temperature[/bold] controls creativity vs consistency:\n"
        "  Low (0.1-0.3) = precise, repeatable answers (best for code)\n"
        "  Medium (0.5-0.7) = balanced\n"
        "  High (0.8-1.5) = creative, varied answers (best for writing)\n\n"
        "[bold]Max tokens[/bold] is the longest response the AI can give.\n"
        "  4096 = short answers  |  8192 = medium  |  16384+ = long/detailed\n\n"
        "[dim]Defaults are pre-set based on your use case.[/dim]"
    ),
    6: (
        "[bold]Here's what your profile looks like[/bold]\n\n"
        "This is the configuration file that will be saved. "
        "You don't need to understand every line -- "
        "the settings above are translated into this format.\n\n"
        "[dim]You can edit this directly if you know YAML, or just press Next.[/dim]"
    ),
    7: (
        "[bold]Name your profile and save[/bold]\n\n"
        "Give your profile a short name (no spaces). Examples:\n"
        "  [dim]my-coder, writing-helper, chat-buddy[/dim]\n\n"
        "You can switch between profiles anytime in Settings."
    ),
}

# --- All known tools for the tool selection step ---------------------------

ALL_TOOLS = [
    ("Read", "Read file contents"),
    ("Edit", "Make targeted edits to files"),
    ("Write", "Create or overwrite files"),
    ("Bash", "Run terminal commands"),
    ("Grep", "Search file contents"),
    ("Glob", "Find files by pattern"),
    ("MultiEdit", "Edit multiple locations at once"),
]


class ProfileWizard(ModalScreen):
    """Multi-step profile creation wizard."""

    DEFAULT_CSS = """
    ProfileWizard {
        align: center middle;
    }

    #wizard-container {
        width: 80;
        height: 35;
        background: $surface;
        border: heavy $accent;
        padding: 1 2;
    }

    #wizard-step-content {
        height: 1fr;
        overflow-y: auto;
    }

    #wizard-buttons {
        dock: bottom;
        height: 3;
        align: right middle;
    }

    #wizard-progress {
        dock: top;
        height: 1;
    }
    """

    def __init__(self, base_url: str = "http://localhost:11434", **kwargs):
        super().__init__(**kwargs)
        self.state = WizardState()
        self.base_url = base_url
        self._models: list[tuple[str, str]] = []
        self._pending_query: str | None = None
        self._pending_field: str | None = None
        self._pending_fallback: any = None

    def compose(self):
        yield Vertical(
            Static(self._progress_text(), id="wizard-progress"),
            Static(STEP_EXPLANATIONS.get(0, ""), id="wizard-explanation"),
            Vertical(id="wizard-step-content"),
            Horizontal(
                Button("Back", variant="default", id="back-btn"),
                Button("Next", variant="primary", id="next-btn"),
                Button("Cancel", variant="error", id="cancel-btn"),
                id="wizard-buttons",
            ),
            id="wizard-container",
        )

    def on_mount(self) -> None:
        self._render_step()

    def _progress_text(self) -> str:
        step = self.state.step + 1
        filled = "\u2501" * step
        remaining = "\u254c" * (STEP_COUNT - step)
        return f"[bold]Step {step} of {STEP_COUNT}[/bold]  [dim]{filled}{remaining}[/dim]"

    def _render_step(self) -> None:
        """Render the current step's widgets into the content area."""
        content = self.query_one("#wizard-step-content", Vertical)
        content.remove_children()

        # Update explanation
        explanation = self.query_one("#wizard-explanation", Static)
        explanation.update(STEP_EXPLANATIONS.get(self.state.step, ""))

        # Update progress
        progress = self.query_one("#wizard-progress", Static)
        progress.update(self._progress_text())

        # Update button labels
        next_btn = self.query_one("#next-btn", Button)
        back_btn = self.query_one("#back-btn", Button)
        next_btn.label = "Save" if self.state.step == 7 else "Next"
        back_btn.disabled = self.state.step == 0

        step = self.state.step
        if step == 0:
            self._render_use_case_step(content)
        elif step == 1:
            self._render_expertise_step(content)
        elif step == 2:
            self._render_behavior_step(content)
        elif step == 3:
            self._render_model_step(content)
        elif step == 4:
            self._render_tools_step(content)
        elif step == 5:
            self._render_tuning_step(content)
        elif step == 6:
            self._render_preview_step(content)
        elif step == 7:
            self._render_name_step(content)

    # --- Step renderers ----------------------------------------------------

    def _render_use_case_step(self, container: Vertical) -> None:
        options = [
            Option(
                f"[bold]{uc['label']}[/bold]  [dim]{uc['description']}[/dim]",
                id=uc["id"],
            )
            for uc in USE_CASES
        ]
        container.mount(OptionList(*options, id="use-case-list"))

    def _render_expertise_step(self, container: Vertical) -> None:
        options = [
            Option(
                "[bold]I'm new to coding[/bold]  [dim]Full guidance + explanations + safety[/dim]",
                id="beginner",
            ),
            Option(
                "[bold]I can read code but need help writing it[/bold]  [dim]Explanations available, warnings only[/dim]",
                id="intermediate",
            ),
            Option(
                "[bold]I'm an experienced developer[/bold]  [dim]Pure terminal, no guardrails[/dim]",
                id="advanced",
            ),
        ]
        container.mount(OptionList(*options, id="expertise-list"))

    def _render_behavior_step(self, container: Vertical) -> None:
        preset = get_preset(self.state.use_case or "custom")
        default_hint = preset["system_prompt_hint"] if preset else ""
        container.mount(
            Static(f"[dim]Default for {self.state.use_case}: {default_hint}[/dim]"),
            Input(
                placeholder="Describe how you want the AI to behave (or press Next for default)...",
                id="behavior-input",
            ),
        )

    def _render_model_step(self, container: Vertical) -> None:
        self._models = fetch_local_models(self.base_url)
        if self._models:
            options = [
                Option(f"{name}  [dim]({size})[/dim]", id=name)
                for name, size in self._models
            ]
            container.mount(OptionList(*options, id="model-list"))
        else:
            container.mount(Static(
                "[yellow]No models found.[/yellow]\n"
                f"Make sure Ollama is running at {self.base_url}\n"
                "Then pull a model: [bold]ollama pull qwen3:8b[/bold]"
            ))

    def _render_tools_step(self, container: Vertical) -> None:
        preset = get_preset(self.state.use_case or "custom")
        suggested = set(preset["suggested_tools"]) if preset else set()
        for tool_name, tool_desc in ALL_TOOLS:
            checked = "[green]\u2713[/green]" if tool_name in suggested else "[dim]\u00b7[/dim]"
            container.mount(
                Static(f"  {checked} [bold]{tool_name}[/bold] -- {tool_desc}")
            )
        container.mount(Static(""))
        container.mount(Input(
            placeholder="Describe what tools you want (or press Next for defaults)...",
            id="tools-input",
        ))

    def _render_tuning_step(self, container: Vertical) -> None:
        container.mount(
            Static(f"Temperature: [bold]{self.state.temperature}[/bold]"),
            Input(value=str(self.state.temperature), id="temp-input"),
            Static(f"\nMax output tokens: [bold]{self.state.max_output_tokens}[/bold]"),
            Input(value=str(self.state.max_output_tokens), id="tokens-input"),
            Static(f"\nContext length: [bold]{self.state.context_length}[/bold]"),
            Input(value=str(self.state.context_length), id="context-input"),
        )

    def _render_preview_step(self, container: Vertical) -> None:
        yaml_str = generate_profile_yaml(self.state)
        container.mount(Static(f"```yaml\n{yaml_str}```"))

    def _render_name_step(self, container: Vertical) -> None:
        suggested = (self.state.use_case or "profile").replace(" ", "-")
        if self.state.model_name:
            suggested = f"{suggested}-{self.state.model_name.split(':')[0]}"
        container.mount(Input(
            value=self.state.profile_name or suggested,
            placeholder="Profile name (no spaces)...",
            id="name-input",
        ))

    # --- Navigation --------------------------------------------------------

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel-btn":
            self.dismiss(None)
        elif event.button.id == "back-btn":
            if self.state.step > 0:
                self.state.step -= 1
                self._render_step()
        elif event.button.id == "next-btn":
            self._advance()

    def _advance(self) -> None:
        """Collect current step's values and advance."""
        step = self.state.step

        if step == 0:
            self._collect_use_case()
        elif step == 1:
            self._collect_expertise()
        elif step == 2:
            self._collect_behavior()
            if self._pending_query:
                return  # Waiting for LLM response — it will advance when ready
        elif step == 3:
            self._collect_model()
        elif step == 4:
            self._collect_tools()
            if self._pending_query:
                return  # Waiting for LLM response
        elif step == 5:
            self._collect_tuning()
        elif step == 6:
            pass  # Preview -- nothing to collect
        elif step == 7:
            self._save_profile()
            return

        if self.state.step < STEP_COUNT - 1:
            self.state.step += 1
            self._render_step()

    def _collect_use_case(self) -> None:
        try:
            option_list = self.query_one("#use-case-list", OptionList)
            if option_list.highlighted is not None:
                idx = option_list.highlighted
                self.state.use_case = USE_CASES[idx]["id"]
        except Exception:
            self.state.use_case = "custom"

        # Apply preset defaults
        preset = get_preset(self.state.use_case or "custom")
        if preset:
            self.state.temperature = preset["temperature"]
            self.state.max_output_tokens = preset["max_output_tokens"]
            self.state.system_prompt_lines = (
                [preset["system_prompt_hint"]] if preset["system_prompt_hint"] else []
            )
            self.state.tools_allowed = list(preset["suggested_tools"])
            self.state.expertise = preset.get("default_expertise", "advanced")

    def _collect_expertise(self) -> None:
        try:
            option_list = self.query_one("#expertise-list", OptionList)
            if option_list.highlighted is not None:
                levels = ["beginner", "intermediate", "advanced"]
                idx = option_list.highlighted
                self.state.expertise = levels[idx]
        except Exception:
            pass

    def _collect_behavior(self) -> None:
        try:
            inp = self.query_one("#behavior-input", Input)
            text = inp.value.strip()
            if text:
                # Send to LLM for rewrite into system prompt lines
                import uuid
                req_id = f"behavior-{uuid.uuid4().hex[:8]}"
                self._pending_query = req_id
                self._pending_field = "behavior"
                self._pending_fallback = [text]  # Fallback: use as-is
                self.app.send_raw_command(json.dumps({
                    "type": "wizard.query",
                    "requestId": req_id,
                    "systemPrompt": "You are helping configure an AI assistant. Rewrite the user's description into 2-3 clear, actionable system prompt instructions. Return ONLY the instructions, one per line. No explanation.",
                    "prompt": text,
                }))
                # Don't advance yet — wait for response or timeout
                return
        except Exception:
            pass

    def _collect_model(self) -> None:
        try:
            option_list = self.query_one("#model-list", OptionList)
            if option_list.highlighted is not None and self._models:
                idx = option_list.highlighted
                self.state.model_name = self._models[idx][0]
        except Exception:
            pass

    def _collect_tools(self) -> None:
        try:
            inp = self.query_one("#tools-input", Input)
            text = inp.value.strip()
            if text:
                # Send to LLM for NL → tool list interpretation
                import uuid
                tool_names = ", ".join(name for name, _ in ALL_TOOLS)
                req_id = f"tools-{uuid.uuid4().hex[:8]}"
                self._pending_query = req_id
                self._pending_field = "tools"
                # Fallback: keyword matching
                text_lower = text.lower()
                fallback_allowed = [n for n, _ in ALL_TOOLS if n.lower() in text_lower]
                fallback_denied = []
                if "no bash" in text_lower or "no terminal" in text_lower:
                    fallback_denied.append("Bash")
                    fallback_allowed = [t for t in fallback_allowed if t != "Bash"]
                self._pending_fallback = {"allowed": fallback_allowed, "denied": fallback_denied}
                self.app.send_raw_command(json.dumps({
                    "type": "wizard.query",
                    "requestId": req_id,
                    "systemPrompt": f"You are helping configure an AI assistant's tool permissions. Available tools: {tool_names}. Based on the user's description, return a JSON object with two arrays: {{\"allowed\": [...], \"denied\": [...]}}. Return ONLY the JSON, no explanation.",
                    "prompt": text,
                }))
                return
        except Exception:
            pass

    def _collect_tuning(self) -> None:
        try:
            temp = self.query_one("#temp-input", Input)
            self.state.temperature = float(temp.value)
        except Exception:
            pass
        try:
            tokens = self.query_one("#tokens-input", Input)
            self.state.max_output_tokens = int(tokens.value)
        except Exception:
            pass
        try:
            ctx = self.query_one("#context-input", Input)
            self.state.context_length = int(ctx.value)
        except Exception:
            pass

    def _save_profile(self) -> None:
        """Validate name, generate YAML, and save via profile.write command."""
        try:
            inp = self.query_one("#name-input", Input)
            name = inp.value.strip().replace(" ", "-").lower()
            if not name:
                self.notify("Please enter a profile name.", severity="error")
                return
            self.state.profile_name = name
        except Exception:
            self.notify("Could not read profile name.", severity="error")
            return

        yaml_str = generate_profile_yaml(self.state)

        # Send profile.write command to engine
        try:
            self.app.send_raw_command(json.dumps({
                "type": "profile.write",
                "name": self.state.profile_name,
                "yaml": yaml_str,
            }))
            self.notify(
                f"Profile '{self.state.profile_name}' saved!\n"
                f"Activate it in Settings > Profiles.",
                severity="information",
            )
            self.dismiss(self.state.profile_name)
        except Exception as e:
            self.notify(f"Save failed: {e}", severity="error")

    # ─── LLM response handler ─────────────────────────────────

    def handle_wizard_response(self, event) -> None:
        """Process a wizard.response from the engine's one-shot LLM call."""
        req_id = getattr(event, "request_id", "")
        if req_id != self._pending_query:
            return  # Stale or mismatched response

        text = getattr(event, "text", "")
        error = getattr(event, "error", None)
        field = self._pending_field

        # Clear pending state
        self._pending_query = None
        self._pending_field = None

        if error or not text.strip():
            # LLM failed — use scripted fallback
            self._apply_fallback(field)
        elif field == "behavior":
            # LLM returned system prompt lines
            lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
            self.state.system_prompt_lines = lines if lines else self._pending_fallback
        elif field == "tools":
            # LLM returned JSON with allowed/denied
            try:
                import json as _json
                parsed = _json.loads(text.strip())
                if isinstance(parsed, dict):
                    self.state.tools_allowed = parsed.get("allowed", [])
                    self.state.tools_denied = parsed.get("denied", [])
                else:
                    self._apply_fallback(field)
            except Exception:
                self._apply_fallback(field)

        self._pending_fallback = None
        # Advance to next step now that we have the LLM result
        if self.state.step < STEP_COUNT - 1:
            self.state.step += 1
            self._render_step()

    def _apply_fallback(self, field: str | None) -> None:
        """Apply the scripted fallback for a failed LLM query."""
        if field == "behavior" and self._pending_fallback:
            self.state.system_prompt_lines = self._pending_fallback
        elif field == "tools" and isinstance(self._pending_fallback, dict):
            self.state.tools_allowed = self._pending_fallback.get("allowed", [])
            self.state.tools_denied = self._pending_fallback.get("denied", [])
