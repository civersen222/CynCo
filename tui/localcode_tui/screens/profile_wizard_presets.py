"""Use-case presets and wizard state for the profile-building wizard.

Every preset includes a plain-language explanation of what it configures
and why — designed for non-engineers who are vibe coding for the first time.
"""
from __future__ import annotations
from dataclasses import dataclass, field


# ─── Use-case presets ──────────────────────────────────────────

USE_CASES: list[dict] = [
    {
        "id": "coding",
        "label": "Coding Assistant",
        "description": "Help me write and fix code",
        "temperature": 0.3,
        "max_output_tokens": 16384,
        "system_prompt_hint": "You are a precise coding assistant. Use tools to read, edit, and test code. Be concise and accurate.",
        "suggested_tools": ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
        "default_expertise": "intermediate",
        "explanation": (
            "This sets up your AI to be a careful coder. It uses a low 'temperature' "
            "(think of it as creativity level) so it gives consistent, predictable answers "
            "instead of creative ones. It has access to file editing and terminal tools "
            "so it can actually make changes to your code, not just talk about them."
        ),
    },
    {
        "id": "writing",
        "label": "Writing Helper",
        "description": "Help me write docs, emails, or content",
        "temperature": 0.8,
        "max_output_tokens": 8192,
        "system_prompt_hint": "You are a creative writing assistant. Help with documentation, emails, blog posts, and other written content. Be expressive and varied in your language.",
        "suggested_tools": ["Read", "Write"],
        "default_expertise": "beginner",
        "explanation": (
            "This sets up your AI for creative writing. It uses a higher 'temperature' "
            "so responses are more varied and creative — better for prose, worse for code. "
            "It only has read/write access (no terminal commands) since you're working "
            "with text, not running programs."
        ),
    },
    {
        "id": "chat",
        "label": "Chat / Q&A",
        "description": "Just talk, ask questions, brainstorm",
        "temperature": 0.7,
        "max_output_tokens": 4096,
        "system_prompt_hint": "You are a helpful conversational assistant. Answer questions clearly and help brainstorm ideas.",
        "suggested_tools": ["Read", "Grep"],
        "default_expertise": "beginner",
        "explanation": (
            "This sets up a general-purpose chat. Balanced 'temperature' for a mix of "
            "consistency and creativity. Limited tool access — it can read your files to "
            "answer questions about them but won't make changes on its own."
        ),
    },
    {
        "id": "custom",
        "label": "Custom",
        "description": "I'll configure everything myself",
        "temperature": 0.7,
        "max_output_tokens": 8192,
        "system_prompt_hint": "",
        "suggested_tools": [],
        "default_expertise": "advanced",
        "explanation": (
            "Start from scratch. You'll set every option yourself — the AI will help you "
            "understand each one as you go. Choose this if you have specific needs that "
            "don't fit the other presets."
        ),
    },
]


def get_preset(use_case_id: str) -> dict | None:
    """Look up a preset by ID. Returns None if not found."""
    for uc in USE_CASES:
        if uc["id"] == use_case_id:
            return uc
    return None


# ─── Wizard state ──────────────────────────────────────────────

@dataclass
class WizardState:
    """Tracks all user choices across the wizard's 8 steps."""
    step: int = 0
    use_case: str | None = None
    expertise: str = "advanced"  # beginner | intermediate | advanced
    model_name: str = ""
    temperature: float = 0.7
    max_output_tokens: int = 8192
    context_length: int = 32768
    system_prompt_lines: list[str] = field(default_factory=list)
    tools_allowed: list[str] = field(default_factory=list)
    tools_denied: list[str] = field(default_factory=list)
    profile_name: str = ""


# ─── YAML generation ──────────────────────────────────────────

def generate_profile_yaml(state: WizardState) -> str:
    """Generate a profile YAML string from wizard state.

    The output is always valid YAML that passes profile.validate.
    Sections with no content (empty system prompt, no tools) are omitted
    so the file stays clean and minimal.
    """
    lines = []
    lines.append(f"name: {state.profile_name}")
    if state.model_name:
        lines.append(f"model: {state.model_name}")
    lines.append(f"temperature: {state.temperature}")
    lines.append(f"max_output_tokens: {state.max_output_tokens}")
    if state.expertise and state.expertise != "advanced":
        lines.append(f"expertise: {state.expertise}")
    if state.context_length != 32768:
        lines.append(f"context_length: {state.context_length}")

    if state.system_prompt_lines:
        lines.append("system_prompt_append: |")
        for line in state.system_prompt_lines:
            lines.append(f"  {line}")

    if state.tools_allowed or state.tools_denied:
        lines.append("tools:")
        if state.tools_allowed:
            lines.append("  allowed:")
            for t in state.tools_allowed:
                lines.append(f"    - {t}")
        if state.tools_denied:
            lines.append("  denied:")
            for t in state.tools_denied:
                lines.append(f"    - {t}")

    return "\n".join(lines) + "\n"
