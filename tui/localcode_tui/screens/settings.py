"""Settings screen -- modal form driven by settings_schema.py."""
from __future__ import annotations

from textual.screen import ModalScreen
from textual.widgets import (
    ContentSwitcher,
    OptionList,
    Input,
    Select,
    Switch,
    Button,
    Static,
)
from textual.widgets.option_list import Option
from textual.containers import Horizontal, Vertical, VerticalScroll

from ..settings_schema import SETTINGS_SCHEMA, validate_field


# ── Constants ────────────────────────────────────────────────────

SECTION_ORDER: list[str] = ["model", "engine", "tools", "context", "ui", "profiles"]

SECTION_LABELS: dict[str, str] = {
    "model": "Model",
    "engine": "Engine",
    "tools": "Tools",
    "context": "Context",
    "ui": "UI",
    "profiles": "Profiles",
}


# ── Pure helpers (testable without Textual app) ─────────────────

def build_section_fields(section: str) -> list[dict]:
    """Return schema fields belonging to *section*.

    Returns [] for "profiles" (managed separately) and unknown sections.
    """
    if section == "profiles" or section not in SECTION_LABELS:
        return []
    return [f for f in SETTINGS_SCHEMA if f["section"] == section]


def build_initial_values() -> dict:
    """Build {name: default} dict from the schema."""
    return {f["name"]: f["default"] for f in SETTINGS_SCHEMA}


def compute_dirty_fields(original: dict, current: dict) -> dict:
    """Return a dict of keys whose values differ between *original* and *current*."""
    return {k: v for k, v in current.items() if original.get(k) != v}


def get_restart_fields() -> set[str]:
    """Return the set of field names that require a restart to apply."""
    return {f["name"] for f in SETTINGS_SCHEMA if f["apply_mode"] == "restart"}


# ── Widget builder ──────────────────────────────────────────────

def _make_field_widget(field: dict, value) -> Vertical:
    """Build a labelled Vertical containing the right input widget for *field*."""
    name = field["name"]
    desc = field.get("description", "")
    restart_badge = " [bold yellow]\u21bb[/bold yellow]" if field["apply_mode"] == "restart" else ""
    label_text = f"[bold]{name}[/bold]{restart_badge}\n[dim]{desc}[/dim]"

    ftype = field["type"]

    if ftype == "bool":
        widget = Switch(value=bool(value), id=f"field-{name}")
    elif ftype == "enum":
        choices = field.get("choices", [])
        options = [(str(c), c) for c in choices]
        widget = Select(options=options, value=value, id=f"field-{name}")
    else:
        # string / int / float -- use a plain Input
        widget = Input(value=str(value), id=f"field-{name}")

    return Vertical(
        Static(label_text, classes="field-label"),
        widget,
        classes="field-row",
    )


def _snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase for engine protocol."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake_key(name: str) -> str:
    """Convert camelCase to snake_case."""
    import re
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()


# ── SettingsScreen ──────────────────────────────────────────────

class SettingsScreen(ModalScreen):
    """Modal settings form driven by SETTINGS_SCHEMA."""

    DEFAULT_CSS = """
    SettingsScreen {
        align: center middle;
    }

    #settings-root {
        width: 90;
        height: 34;
        background: $surface;
        border: heavy $accent;
    }

    #settings-body {
        height: 1fr;
    }

    #nav {
        width: 20;
        height: 100%;
        border-right: solid $accent;
    }

    #pane-area {
        width: 1fr;
        height: 100%;
        padding: 1 2;
    }

    .field-row {
        height: auto;
        margin-bottom: 1;
    }

    .field-label {
        margin-bottom: 0;
    }

    #button-bar {
        height: 3;
        align: right middle;
        padding: 0 2;
        dock: bottom;
    }

    #button-bar Button {
        margin-left: 1;
    }

    .section-pane {
        height: 100%;
    }

    .empty-pane {
        padding: 2 4;
    }
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._original: dict = build_initial_values()
        self._current: dict = dict(self._original)

    def compose(self):
        nav_options = [
            Option(SECTION_LABELS[s], id=s)
            for s in SECTION_ORDER
        ]
        nav = OptionList(*nav_options, id="nav")

        # Build one pane per section inside ContentSwitcher
        switcher = ContentSwitcher(id="pane-switcher", initial=SECTION_ORDER[0])
        panes: list[VerticalScroll] = []
        for section in SECTION_ORDER:
            fields = build_section_fields(section)
            if fields:
                children = [_make_field_widget(f, self._current[f["name"]]) for f in fields]
                pane = VerticalScroll(*children, id=section, classes="section-pane")
            elif section == "tools":
                pane = VerticalScroll(
                    Static("[bold]Tools[/bold]\n"),
                    Static("[dim]Loading tool list from engine...[/dim]\n"),
                    Static("[dim]Use Apply to save tool permission changes.[/dim]"),
                    id=section,
                    classes="section-pane",
                )
            elif section == "profiles":
                pane = VerticalScroll(
                    Static("[bold]Profiles[/bold]\n"),
                    Static("Manage your LocalCode profiles here.\n"),
                    Button("Create New Profile", variant="primary", id="create-profile-btn"),
                    Static("\n[dim]Switch or delete profiles coming in next update.[/dim]"),
                    id=section,
                )
            else:
                pane = VerticalScroll(
                    Static("[dim]No settings in this section yet.[/dim]"),
                    id=section,
                    classes="section-pane empty-pane",
                )
            panes.append(pane)

        yield Vertical(
            Static("[bold]Settings[/bold]\n", id="settings-title"),
            Horizontal(
                nav,
                switcher,
                id="settings-body",
            ),
            Horizontal(
                Button("Apply", variant="success", id="apply"),
                Button("Revert", variant="warning", id="revert"),
                Button("Close", variant="error", id="close"),
                id="button-bar",
            ),
            id="settings-root",
        )

        # Mount panes into the switcher after it is composed
        for pane in panes:
            switcher.mount(pane)

    # ── Nav handling ────────────────────────────────────────────

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        option_id = event.option.id
        if option_id and option_id in [s for s in SECTION_ORDER]:
            switcher = self.query_one("#pane-switcher", ContentSwitcher)
            switcher.current = option_id

    # ── Button handling ─────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "close":
            self.dismiss(None)
        elif event.button.id == "revert":
            self._revert()
        elif event.button.id == "apply":
            self._apply()
        elif event.button.id == "create-profile-btn":
            from .profile_wizard import ProfileWizard

            def on_wizard_done(result) -> None:
                if result:
                    self.notify(f"Profile '{result}' created!", severity="information")

            self.app.push_screen(ProfileWizard(), on_wizard_done)

    # ── Apply / Revert ──────────────────────────────────────────

    def _collect_current_values(self) -> dict:
        """Read widget values back into a dict."""
        values: dict = {}
        for field in SETTINGS_SCHEMA:
            name = field["name"]
            widget_id = f"field-{name}"
            try:
                widget = self.query_one(f"#{widget_id}")
            except Exception:
                values[name] = self._current.get(name, field["default"])
                continue

            if isinstance(widget, Switch):
                values[name] = widget.value
            elif isinstance(widget, Select):
                values[name] = widget.value
            elif isinstance(widget, Input):
                raw = widget.value
                if field["type"] == "int":
                    try:
                        values[name] = int(raw)
                    except ValueError:
                        values[name] = field["default"]
                elif field["type"] == "float":
                    try:
                        values[name] = float(raw)
                    except ValueError:
                        values[name] = field["default"]
                else:
                    values[name] = raw
            else:
                values[name] = self._current.get(name, field["default"])
        return values

    def _apply(self) -> None:
        """Collect current values, validate, send config.update to engine, persist."""
        import json
        self._current = self._collect_current_values()
        dirty = compute_dirty_fields(self._original, self._current)
        if not dirty:
            self.notify("No changes to apply.", severity="information")
            return

        # Validate all dirty fields
        errors = []
        for name, value in dirty.items():
            err = validate_field(name, value)
            if err:
                errors.append(f"{name}: {err}")
        if errors:
            self.notify("\n".join(errors), severity="error")
            return

        # Convert snake_case to camelCase for engine protocol
        patches = {}
        for name, value in dirty.items():
            camel = _snake_to_camel(name)
            patches[camel] = value

        # Send config.update to engine
        try:
            self.app.send_raw_command(json.dumps({
                "type": "config.update",
                "patches": patches,
            }))
        except Exception as e:
            self.notify(f"Failed to send config: {e}", severity="error")
            return

        # Persist to TUI config file
        try:
            from ..config import load_config as _load_cfg, save_config as _save_cfg
            cfg = _load_cfg()
            for name, value in dirty.items():
                if hasattr(cfg, name):
                    setattr(cfg, name, value)
                elif hasattr(cfg.ui, name):
                    setattr(cfg.ui, name, value)
                elif hasattr(cfg.context_management, name):
                    setattr(cfg.context_management, name, value)
            _save_cfg(cfg)
        except Exception:
            pass

        # Update originals so fields are no longer dirty
        self._original = dict(self._current)

        # Notify success
        restart = get_restart_fields()
        restart_dirty = [k for k in dirty if k in restart]
        if restart_dirty:
            self.notify(
                f"Applied {len(dirty)} change(s). Restart needed for: {', '.join(restart_dirty)}",
                severity="warning",
            )
        else:
            self.notify(f"Applied {len(dirty)} change(s).", severity="information")

    def _revert(self) -> None:
        """Reset all widgets to original values."""
        for field in SETTINGS_SCHEMA:
            name = field["name"]
            widget_id = f"field-{name}"
            original_val = self._original[name]
            try:
                widget = self.query_one(f"#{widget_id}")
            except Exception:
                continue

            if isinstance(widget, Switch):
                widget.value = bool(original_val)
            elif isinstance(widget, Select):
                widget.value = original_val
            elif isinstance(widget, Input):
                widget.value = str(original_val)

        self._current = dict(self._original)

    # ── Engine event handlers ───────────────────────────────────

    def on_mount(self) -> None:
        """Request tool list from engine on settings open."""
        import json
        try:
            self.app.send_raw_command(json.dumps({"type": "tools.list"}))
        except Exception:
            pass

    def handle_tools_list(self, event) -> None:
        """Populate the tools section with toggles from engine's tool registry."""
        tools = getattr(event, "tools", [])
        if not tools:
            return
        try:
            pane = self.query_one("#tools", VerticalScroll)
            pane.remove_children()
            pane.mount(Static("[bold]Tools[/bold]\n"))
            pane.mount(Static("[dim]Toggle which tools the AI can use:[/dim]\n"))
            for t in tools:
                name = t.get("name", "?") if isinstance(t, dict) else getattr(t, "name", "?")
                desc = t.get("description", "") if isinstance(t, dict) else getattr(t, "description", "")
                enabled = t.get("enabled", True) if isinstance(t, dict) else getattr(t, "enabled", True)
                tier = t.get("tier", "auto") if isinstance(t, dict) else getattr(t, "tier", "auto")
                tier_badge = "[green]auto[/green]" if tier == "auto" else "[yellow]approval[/yellow]"
                sw = Switch(value=enabled, id=f"tool-{name}")
                pane.mount(Horizontal(
                    sw,
                    Static(f" [bold]{name}[/bold] {tier_badge}  [dim]{desc[:50]}[/dim]"),
                    classes="field-row",
                ))
            pane.mount(Static("\n[dim]Use Apply to send changes to engine.[/dim]"))
        except Exception:
            pass

    def handle_config_current(self, event) -> None:
        """Receive current engine config values."""
        config = getattr(event, "config", {})
        if not config:
            return
        for key, value in config.items():
            snake = _camel_to_snake_key(key)
            if snake in self._current:
                self._current[snake] = value
                self._original[snake] = value

    def handle_config_updated(self, event) -> None:
        """Acknowledge applied config changes from engine."""
        applied = getattr(event, "applied", {})
        errors = getattr(event, "errors", None)
        if errors:
            msgs = [f"{e.get('field', '?')}: {e.get('message', '?')}" for e in errors]
            self.notify("Engine rejected:\n" + "\n".join(msgs), severity="error")
        if applied:
            self.notify(f"Engine confirmed {len(applied)} change(s).", severity="information")
