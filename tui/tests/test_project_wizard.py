import pytest
import json


class TestQuestionParsing:
    def test_parse_question_with_options(self):
        from localcode_tui.screens.project_wizard import parse_llm_question
        raw = "What should your app look like?\nA) Web page\nB) Terminal\nC) Mobile\nD) Not sure"
        result = parse_llm_question(raw)
        assert result["question"] == "What should your app look like?"
        assert len(result["options"]) == 4
        assert result["options"][0] == "Web page"

    def test_parse_question_numbered(self):
        from localcode_tui.screens.project_wizard import parse_llm_question
        raw = "How many users?\n1. Just me\n2. A team\n3. Public"
        result = parse_llm_question(raw)
        assert len(result["options"]) == 3

    def test_parse_question_no_options(self):
        from localcode_tui.screens.project_wizard import parse_llm_question
        raw = "Just a plain question with no options"
        result = parse_llm_question(raw)
        assert result["question"] == raw.strip()
        assert result["options"] == []

    def test_parse_ready_signal(self):
        from localcode_tui.screens.project_wizard import parse_llm_question
        raw = "READY"
        result = parse_llm_question(raw)
        assert result["ready"] is True


class TestPlanParsing:
    def test_parse_phases_json(self):
        from localcode_tui.screens.project_wizard import parse_plan_phases
        raw = json.dumps([
            {"name": "Setup", "description": "Create files", "prompt": "Create the project structure"},
            {"name": "Build", "description": "Core logic", "prompt": "Build the main feature"},
        ])
        phases = parse_plan_phases(raw)
        assert len(phases) == 2
        assert phases[0]["name"] == "Setup"
        assert phases[1]["prompt"] == "Build the main feature"

    def test_parse_phases_with_markdown_wrapper(self):
        from localcode_tui.screens.project_wizard import parse_plan_phases
        raw = "```json\n" + json.dumps([{"name": "A", "description": "B", "prompt": "C"}]) + "\n```"
        phases = parse_plan_phases(raw)
        assert len(phases) == 1

    def test_parse_phases_invalid_json_returns_empty(self):
        from localcode_tui.screens.project_wizard import parse_plan_phases
        phases = parse_plan_phases("this is not json at all")
        assert phases == []

    def test_parse_phases_non_array_returns_empty(self):
        from localcode_tui.screens.project_wizard import parse_plan_phases
        phases = parse_plan_phases('{"not": "an array"}')
        assert phases == []


class TestProjectState:
    def test_initial_state(self):
        from localcode_tui.screens.project_wizard import ProjectState
        state = ProjectState(description="Build a todo app")
        assert state.description == "Build a todo app"
        assert state.phase == "brainstorm"
        assert len(state.qa_pairs) == 0
        assert len(state.plan_phases) == 0

    def test_state_tracks_qa_pairs(self):
        from localcode_tui.screens.project_wizard import ProjectState
        state = ProjectState(description="test")
        state.qa_pairs.append(("What type?", "Web page"))
        state.qa_pairs.append(("How many users?", "Just me"))
        assert len(state.qa_pairs) == 2
