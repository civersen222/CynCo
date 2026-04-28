"""Guided project wizard — brainstorm → design → plan for non-engineers.

Walks users through expanding their project idea into a structured plan
using LLM-generated multiple-choice questions. All LLM calls go through
the existing wizard.query/wizard.response protocol.

Phases:
  1. BRAINSTORM — LLM asks clarifying questions (up to 8)
  2. DESIGN — LLM synthesizes answers into a summary
  3. PLAN — LLM breaks design into 3-5 implementation phases
  4. DONE — returns phases for workspace to execute
"""
from __future__ import annotations
import json
import re
import uuid
from dataclasses import dataclass, field
from textual.screen import ModalScreen
from textual.containers import Vertical, Horizontal, VerticalScroll
from textual.widgets import Static, Button, Input, OptionList
from textual.widgets.option_list import Option

from ..widgets.worker_animation import WorkerAnimation


MAX_QUESTIONS = 12

# ─── Pure helpers (testable) ───────────────────────────────────

def parse_llm_question(raw: str) -> dict:
    """Parse an LLM-generated question with options.

    Returns: {"question": str, "options": list[str], "ready": bool}
    """
    text = raw.strip()
    if text.upper() == "READY":
        return {"question": "", "options": [], "ready": True}

    lines = text.split("\n")
    question = lines[0].strip()
    options = []

    for line in lines[1:]:
        line = line.strip()
        # Match A) option, B) option, etc.
        m = re.match(r'^[A-Da-d][).\]]\s*(.+)', line)
        if m:
            options.append(m.group(1).strip())
            continue
        # Match 1. option, 2. option, etc.
        m = re.match(r'^\d+[).\]]\s*(.+)', line)
        if m:
            options.append(m.group(1).strip())

    return {"question": question, "options": options, "ready": False}


def parse_plan_phases(raw: str) -> list[dict]:
    """Parse LLM-generated plan phases from JSON.

    Expected format: [{name, description, prompt}, ...]
    Returns empty list on parse failure.
    """
    text = raw.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        parsed = json.loads(text)
        if not isinstance(parsed, list):
            return []
        # Validate each phase has required fields
        result = []
        for item in parsed:
            if isinstance(item, dict) and "name" in item:
                result.append({
                    "name": item.get("name", ""),
                    "description": item.get("description", ""),
                    "prompt": item.get("prompt", item.get("description", "")),
                })
        return result
    except (json.JSONDecodeError, ValueError):
        return []


@dataclass
class ProjectState:
    """Tracks the guided project wizard's state across phases."""
    description: str = ""
    phase: str = "brainstorm"  # brainstorm | design | plan | done
    research: str = ""  # Deep knowledge summary from research phase
    qa_pairs: list[tuple[str, str]] = field(default_factory=list)
    question_count: int = 0
    current_question: str = ""
    current_options: list[str] = field(default_factory=list)
    design_summary: str = ""
    plan_phases: list[dict] = field(default_factory=list)


# ─── Prompts ───────────────────────────────────────────────────

RESEARCH_SYSTEM = (
    "You are a product research expert. The user described a software project. "
    "Analyze their description and produce a DEEP KNOWLEDGE SUMMARY of every "
    "product, game, app, or concept they referenced.\n\n"
    "For each reference, list:\n"
    "- Core mechanics / features that define it\n"
    "- What makes it great / what players love about it\n"
    "- Key systems that would need to be implemented\n"
    "- Common pitfalls when building something similar\n\n"
    "Be EXTREMELY specific and detailed. For example, if they mention 'Civilization', "
    "don't just say 'strategy game'. List: hex tile map with terrain types (plains, "
    "hills, mountains, ocean, desert), fog of war, city founding with population growth, "
    "tile improvement workers, tech tree with ~70 techs across 8 eras, multiple victory "
    "conditions (science/culture/domination/diplomatic/religious), unit combat with "
    "promotions, diplomatic AI with leader agendas, etc.\n\n"
    "This research will be used to ask the user specific design questions and to "
    "write detailed implementation plans. Be thorough — 300-500 words minimum."
)

MOCKUP_SYSTEM = (
    "You are a UI/UX designer creating an HTML mockup. Generate a COMPLETE, "
    "self-contained HTML file (with inline CSS and minimal JS) that shows what "
    "the proposed application will look like.\n\n"
    "Requirements:\n"
    "- Single HTML file, all CSS inline in <style>, all JS inline in <script>\n"
    "- Show the MAIN screen/view of the application with realistic sample data\n"
    "- Include navigation, key UI elements, and interactive components\n"
    "- Use a clean, modern dark theme\n"
    "- Make it look like a real product mockup, not a wireframe\n"
    "- Include placeholder content that shows what real data would look like\n"
    "- For games: show the main game screen with map/board, UI panels, stats\n"
    "- For apps: show the primary view with navigation and sample content\n"
    "- Add a banner at top: 'LocalCode Design Preview — This is a mockup'\n\n"
    "Return ONLY the HTML. No markdown, no explanation, no code fences. "
    "Just the raw HTML starting with <!DOCTYPE html>."
)

BRAINSTORM_SYSTEM = (
    "You are an expert product designer helping someone build software. "
    "When the user references existing products, games, apps, or services, you KNOW "
    "those products deeply — their core mechanics, UX patterns, what makes them great, "
    "and what specific features define them.\n\n"
    "Your job: ask ONE focused question about a SPECIFIC design decision, drawing on "
    "your knowledge of the referenced products. Don't ask generic questions like "
    "'what platform?' — ask about the specific mechanics and features that matter.\n\n"
    "For example, if someone says 'like Civilization', you know that means 4X gameplay, "
    "hex/tile maps, tech trees, multiple victory conditions, diplomacy, city management, "
    "unit combat, fog of war, etc. Ask which of those specific mechanics they want.\n\n"
    "Format your response EXACTLY like this:\n"
    "Your question here?\n"
    "A) First option\n"
    "B) Second option\n"
    "C) Third option\n"
    "D) Fourth option\n\n"
    "Rules: ONE question, ONE topic, 3-4 options. No explanations or reasoning. "
    "The user is not a programmer — use plain language. "
    "If you have enough information to fully design the project, respond with just READY."
)

DESIGN_SYSTEM = (
    "You are an expert product designer writing a detailed design document. "
    "When the user references existing products, you KNOW those products deeply. "
    "Synthesize their requirements into a COMPREHENSIVE feature list — not a vague "
    "summary, but specific mechanics and systems that need to be built.\n\n"
    "For each feature, describe exactly what it does and how it works. "
    "For example, don't say 'combat system' — say 'Turn-based combat where units "
    "have attack/defense/movement stats, terrain provides bonuses, and flanking "
    "deals extra damage.'\n\n"
    "Organize into sections. Be thorough — this document drives what gets built. "
    "If something is vague, make a reasonable decision based on the referenced products. "
    "Write 15-25 bullet points covering every major system. No code."
)

PLAN_SYSTEM = (
    "You are a senior software architect creating a detailed implementation plan. "
    "Break this design into 5-8 implementation phases, ordered by dependency.\n\n"
    "CRITICAL: Each phase's 'prompt' field must be EXTREMELY detailed — it is the "
    "complete instruction an AI coding assistant will follow to build that phase. "
    "Include:\n"
    "- Exact data structures and their fields\n"
    "- Specific algorithms and game logic\n"
    "- UI layout and interaction details\n"
    "- How this phase connects to previous phases\n"
    "- Edge cases and error handling\n\n"
    "A vague prompt like 'build the combat system' produces garbage. A good prompt "
    "specifies 'Create a combat resolver that takes two armies (each an array of "
    "{type, attack, defense, hp, morale} units), applies terrain modifiers from the "
    "tile data, resolves attacks in initiative order, handles retreat when morale "
    "drops below 30%, and returns the battle outcome with casualties.'\n\n"
    "Return ONLY a JSON array: "
    '[{"name": "Phase name", "description": "What this builds", '
    '"prompt": "EXTREMELY detailed multi-paragraph instruction for the AI coder"}]. '
    "No text outside the JSON. Each prompt should be 200-500 words."
)


# ─── Screen ────────────────────────────────────────────────────

class ProjectWizard(ModalScreen):
    """Guided project wizard: brainstorm → design → plan."""

    DEFAULT_CSS = """
    ProjectWizard {
        align: center middle;
    }

    #project-container {
        width: 80;
        height: 35;
        background: $surface;
        border: heavy $accent;
        padding: 1 2;
    }

    #project-content {
        height: 1fr;
        overflow-y: auto;
    }

    #project-buttons {
        dock: bottom;
        height: 3;
        align: right middle;
    }

    #project-header {
        height: auto;
    }
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.state = ProjectState()
        self._pending_query: str | None = None

    def compose(self):
        yield Vertical(
            Static("[bold]Start a Project[/bold]\n", id="project-header"),
            VerticalScroll(id="project-content"),
            Horizontal(
                Button("Start", variant="primary", id="btn-start"),
                Button("Next", variant="primary", id="btn-next"),
                Button("Show me a mockup", variant="success", id="btn-mockup"),
                Button("Looks good \u2014 plan it", variant="primary", id="btn-plan"),
                Button("Build it!", variant="primary", id="btn-build"),
                Button("Start over", variant="warning", id="btn-restart"),
                Button("Cancel", variant="error", id="btn-cancel"),
                id="project-buttons",
            ),
            id="project-container",
        )

    def on_mount(self) -> None:
        self._render_phase()

    def _render_phase(self) -> None:
        content = self.query_one("#project-content", VerticalScroll)
        content.remove_children()
        header = self.query_one("#project-header", Static)

        if self.state.phase == "brainstorm":
            if self.state.question_count == 0:
                header.update("[bold]What would you like to build?[/bold]\n")
                content.mount(
                    Static("[dim]Describe your idea in a sentence or two. "
                           "I'll ask some questions to understand what you need.[/dim]\n"),
                    Input(placeholder="e.g. 'A todo list app' or 'A website for my bakery'",
                          id="project-desc-input"),
                )
                self._show_buttons("btn-start", "btn-cancel")
            else:
                header.update(f"[bold]Brainstorming[/bold]  [dim]Question {self.state.question_count} of up to {MAX_QUESTIONS}[/dim]\n")
                if self.state.current_question:
                    content.mount(Static(f"[bold]{self.state.current_question}[/bold]\n"))
                    if self.state.current_options:
                        options = [Option(opt, id=str(i)) for i, opt in enumerate(self.state.current_options)]
                        content.mount(OptionList(*options, id="question-options"))
                    else:
                        content.mount(Input(placeholder="Type your answer...", id="answer-input"))
                self._show_buttons("btn-next", "btn-cancel")

        elif self.state.phase == "design":
            header.update("[bold]Here's what I understand[/bold]\n")
            if self.state.design_summary:
                content.mount(Static(self.state.design_summary))
                content.mount(Static("\n[dim]Does this look right?[/dim]"))
                self._show_buttons("btn-mockup", "btn-plan", "btn-restart", "btn-cancel")
            else:
                content.mount(Static("[dim]Synthesizing your answers...[/dim]"))

        elif self.state.phase == "plan":
            header.update("[bold]Implementation Plan[/bold]\n")
            if self.state.plan_phases:
                for i, phase in enumerate(self.state.plan_phases, 1):
                    content.mount(Static(
                        f"[bold]{i}. {phase['name']}[/bold]\n"
                        f"   [dim]{phase['description']}[/dim]\n"
                    ))
                content.mount(Static("\n[dim]Ready to start building?[/dim]"))
                self._show_buttons("btn-build", "btn-restart", "btn-cancel")
            else:
                content.mount(Static("[dim]Breaking into phases...[/dim]"))

        elif self.state.phase == "done":
            self.dismiss(self.state.plan_phases)

    def _show_buttons(self, *visible_ids: str) -> None:
        """Show only the specified buttons, hide the rest."""
        all_btn_ids = ["btn-start", "btn-next", "btn-mockup", "btn-plan", "btn-build", "btn-restart", "btn-cancel"]
        for btn_id in all_btn_ids:
            try:
                btn = self.query_one(f"#{btn_id}", Button)
                btn.display = btn_id in visible_ids
            except Exception:
                pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn = event.button.id or ""
        if btn == "btn-cancel":
            self.dismiss(None)
        elif btn == "btn-restart":
            self.state = ProjectState()
            self._pending_query = None
            self._render_phase()
        elif btn == "btn-start":
            self._start_brainstorm()
        elif btn == "btn-next":
            self._submit_answer()
        elif btn == "btn-mockup":
            self._generate_mockup()
        elif btn == "btn-plan":
            self._start_planning()
        elif btn == "btn-build":
            self.state.phase = "done"
            self._render_phase()
        elif btn == "start-over":
            self.state = ProjectState()
            self._render_phase()

    # ─── Brainstorm flow ───────────────────────────────────────

    def _start_brainstorm(self) -> None:
        try:
            inp = self.query_one("#project-desc-input", Input)
            desc = inp.value.strip()
            if not desc:
                self.notify("Please describe what you want to build.", severity="error")
                return
            self.state.description = desc
        except Exception:
            return

        # First: ask the LLM to research the user's references and produce
        # a knowledge summary that feeds into all subsequent questions
        self._research_references()

    def _research_references(self) -> None:
        """Search the web for information about referenced products, then
        synthesize into a knowledge base using the LLM."""
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            anim = WorkerAnimation(id="wizard-worker")
            content.mount(anim)
            anim.start_activity("search")
        except Exception:
            pass

        # Step 1: Generate search queries from the description
        # Extract key terms and search for them
        desc = self.state.description.lower()
        queries = []

        # Extract game/product names and generate targeted searches
        # Common patterns: "like X", "similar to X", "combines X and Y"
        import re
        # Find quoted or capitalized product names
        words = self.state.description.split()
        # Build search queries from the description
        queries.append(f"{self.state.description} game mechanics features")

        # Look for specific game references
        known_games = ["civilization", "crusader kings", "stellaris", "europa universalis",
                       "total war", "sim city", "cities skylines", "factorio", "rimworld",
                       "dwarf fortress", "minecraft", "terraria", "stardew valley",
                       "animal crossing", "zelda", "dark souls", "elden ring"]
        for game in known_games:
            if game in desc:
                queries.append(f"{game} core mechanics features gameplay systems")
                queries.append(f"{game} what makes it good design analysis")

        # If no specific games found, search based on genre keywords
        if len(queries) == 1:
            queries.append(f"{self.state.description} similar games features")

        # Cap at 5 searches
        queries = queries[:5]

        req_id = f"search-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id
        self._search_queries = queries
        try:
            self.app.send_raw_command(json.dumps({
                "type": "web.search",
                "requestId": req_id,
                "queries": queries,
            }))
        except Exception:
            self.state.question_count = 1
            self._ask_next_question()

    def handle_search_result(self, event) -> None:
        """Handle web search results — feed them to LLM for synthesis."""
        req_id = getattr(event, "request_id", "")
        if req_id != self._pending_query:
            return

        results = getattr(event, "results", "")
        self._pending_query = None

        if not results or results == "No search results found.":
            self.notify("Web search returned no results — using model knowledge", severity="warning")
            # Fall back to LLM-only research
            req_id2 = f"research-{uuid.uuid4().hex[:8]}"
            self._pending_query = req_id2
            self.app.send_raw_command(json.dumps({
                "type": "wizard.query",
                "requestId": req_id2,
                "systemPrompt": RESEARCH_SYSTEM,
                "prompt": f"The user wants to build: {self.state.description}\n\nResearch this deeply.",
            }))
            return

        # Step 2: Feed search results to LLM for synthesis
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            anim = WorkerAnimation(id="wizard-worker")
            content.mount(anim)
            anim.start_activity("think")
        except Exception:
            pass

        req_id2 = f"research-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id2
        self.app.send_raw_command(json.dumps({
            "type": "wizard.query",
            "requestId": req_id2,
            "systemPrompt": RESEARCH_SYSTEM,
            "prompt": (
                f"The user wants to build: {self.state.description}\n\n"
                f"Here is real web research about the products/games they referenced:\n\n"
                f"{results}\n\n"
                f"Using this research AND your own knowledge, produce a comprehensive "
                f"analysis of the core mechanics, features, and systems that need to be "
                f"implemented. Be extremely specific and detailed."
            ),
        }))

    def _ask_next_question(self) -> None:
        context = f"Project: {self.state.description}\n"
        if self.state.research:
            context += f"\nResearch on referenced products:\n{self.state.research}\n"
        if self.state.qa_pairs:
            context += "\nPrevious answers:\n"
            for q, a in self.state.qa_pairs:
                context += f"Q: {q}\nA: {a}\n"

        # Show worker animation while thinking
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            anim = WorkerAnimation(id="wizard-worker")
            content.mount(anim)
            anim.start_activity("think")
        except Exception:
            pass

        req_id = f"brainstorm-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id
        self.notify(f"Sending brainstorm query {req_id}...", severity="information")
        try:
            self.app.send_raw_command(json.dumps({
                "type": "wizard.query",
                "requestId": req_id,
                "systemPrompt": BRAINSTORM_SYSTEM,
                "prompt": context + "\nAsk the next clarifying question (or say READY if you have enough info):",
            }))
            self.notify("Query sent to engine", severity="information")
        except Exception as e:
            self.notify(f"Failed to send query: {e}", severity="error")
            self._fallback_to_design()

    def _submit_answer(self) -> None:
        answer = ""
        try:
            option_list = self.query_one("#question-options", OptionList)
            if option_list.highlighted is not None:
                idx = option_list.highlighted
                answer = self.state.current_options[idx]
        except Exception:
            pass

        if not answer:
            try:
                inp = self.query_one("#answer-input", Input)
                answer = inp.value.strip()
            except Exception:
                pass

        if not answer:
            return

        self.state.qa_pairs.append((self.state.current_question, answer))
        self.state.question_count += 1

        if self.state.question_count > MAX_QUESTIONS:
            self._start_design()
        else:
            self._ask_next_question()

    def _fallback_to_design(self) -> None:
        self.state.design_summary = (
            f"Build: {self.state.description}\n\n"
            + "\n".join(f"- {q}: {a}" for q, a in self.state.qa_pairs)
        )
        self.state.phase = "design"
        self._render_phase()

    # ─── Design flow ───────────────────────────────────────────

    def _start_design(self) -> None:
        self.state.phase = "design"
        self._render_phase()

        context = f"Project idea: {self.state.description}\n"
        if self.state.research:
            context += f"\nResearch on referenced products:\n{self.state.research}\n"
        context += "\nRequirements gathered:\n"
        for q, a in self.state.qa_pairs:
            context += f"- {q}: {a}\n"

        req_id = f"design-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id
        try:
            self.app.send_raw_command(json.dumps({
                "type": "wizard.query",
                "requestId": req_id,
                "systemPrompt": DESIGN_SYSTEM,
                "prompt": context,
            }))
        except Exception:
            self._fallback_to_design()

    # ─── Plan flow ─────────────────────────────────────────────

    # ─── Mockup flow ────────────────────────────────────────────

    def _generate_mockup(self) -> None:
        """Ask the LLM to generate an HTML mockup of the proposed design."""
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            content.mount(Static(
                "[bold yellow]Generating visual mockup...[/bold yellow]\n\n"
                "[dim]Creating an HTML preview you can see in your browser.[/dim]"
            ))
        except Exception:
            pass

        req_id = f"mockup-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id
        self.app.send_raw_command(json.dumps({
            "type": "wizard.query",
            "requestId": req_id,
            "systemPrompt": MOCKUP_SYSTEM,
            "prompt": f"Design to visualize:\n{self.state.design_summary}",
        }))

    def _show_mockup(self, html: str) -> None:
        """Save mockup HTML and open in browser."""
        import os
        import webbrowser

        # Determine project dir
        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        mockup_path = os.path.join(project_dir, '.cynco-mockup.html')

        try:
            with open(mockup_path, 'w', encoding='utf-8') as f:
                f.write(html)
            webbrowser.open(f'file:///{mockup_path}')
            self.notify("Mockup opened in your browser!", severity="information")
        except Exception as e:
            self.notify(f"Could not open mockup: {e}", severity="error")

        # Return to design phase with mockup shown
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            content.mount(Static(self.state.design_summary))
            content.mount(Static(
                f"\n[bold green]Mockup opened in your browser![/bold green]\n"
                f"[dim]File: {mockup_path}[/dim]\n\n"
                f"[dim]Review the visual preview, then come back here.[/dim]"
            ))
            self._show_buttons("btn-plan", "btn-mockup", "btn-restart", "btn-cancel")
        except Exception:
            pass

    # ─── Plan flow ─────────────────────────────────────────────

    def _start_planning(self) -> None:
        self.state.phase = "plan"
        self._render_phase()

        req_id = f"plan-{uuid.uuid4().hex[:8]}"
        self._pending_query = req_id
        try:
            self.app.send_raw_command(json.dumps({
                "type": "wizard.query",
                "requestId": req_id,
                "systemPrompt": PLAN_SYSTEM,
                "prompt": f"Design:\n{self.state.design_summary}",
            }))
        except Exception:
            # Fallback: single phase
            self.state.plan_phases = [{
                "name": "Build everything",
                "description": self.state.description,
                "prompt": f"Build the following: {self.state.design_summary}",
            }]
            self._render_phase()

    # ─── Response handler ──────────────────────────────────────

    def handle_wizard_response(self, event) -> None:
        req_id = getattr(event, "request_id", "")
        if req_id != self._pending_query:
            self.notify(f"Stale response: {req_id} (expected {self._pending_query})", severity="warning")
            return

        text = getattr(event, "text", "")
        error = getattr(event, "error", None)
        self._pending_query = None

        self.notify(f"Got response: {'ERROR: '+error if error else text[:60]}", severity="information")

        if req_id.startswith("research-"):
            # Research phase complete — store and start questions
            if text.strip():
                self.state.research = text.strip()
                self.notify("Research complete — starting questions", severity="information")
            else:
                self.notify("Research skipped — starting questions", severity="warning")
            self.state.question_count = 1
            self._ask_next_question()
            return

        if req_id.startswith("brainstorm-"):
            if error or not text.strip():
                self.notify(f"Brainstorm failed: {error or 'empty response'}", severity="error")
                self._fallback_to_design()
                return
            parsed = parse_llm_question(text)
            if parsed["ready"] or self.state.question_count > MAX_QUESTIONS:
                self._start_design()
            else:
                self.state.current_question = parsed["question"]
                self.state.current_options = parsed["options"]
                self._render_phase()

        elif req_id.startswith("mockup-"):
            if error or not text.strip():
                self.notify("Mockup generation failed — continuing without preview", severity="warning")
            else:
                # Extract HTML — strip markdown fences if present
                html = text.strip()
                if html.startswith("```"):
                    lines = html.split("\n")
                    html = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
                self._show_mockup(html)

        elif req_id.startswith("design-"):
            if error or not text.strip():
                self._fallback_to_design()
            else:
                self.state.design_summary = text.strip()
            self._render_phase()

        elif req_id.startswith("plan-"):
            if error or not text.strip():
                self.state.plan_phases = [{
                    "name": "Build everything",
                    "description": self.state.description,
                    "prompt": f"Build the following: {self.state.design_summary}",
                }]
            else:
                phases = parse_plan_phases(text)
                self.state.plan_phases = phases if phases else [{
                    "name": "Build everything",
                    "description": self.state.description,
                    "prompt": f"Build the following: {self.state.design_summary}",
                }]
            self._render_phase()
