#!/usr/bin/env python3
"""Aggregate S5 training data from decision logs.

Reads ~/.localcode/decisions/*.jsonl files, converts each DecisionRecord
into a TrainingExample (input prompt + derived decision JSON), and writes
a combined JSONL file suitable for fine-tuning.

Usage:
    python aggregate_training_data.py [--output path/to/output.jsonl]
    python aggregate_training_data.py --decisions-dir /custom/path
"""
import argparse
import json
import os
import sys
from pathlib import Path


def derive_decision(record: dict) -> dict:
    """Derive an S5 decision from a historical DecisionRecord."""
    context_pct = record.get("contextUsagePercent", 0.0)
    tool_results = record.get("toolResults", [])
    tools_called = record.get("toolsCalled", [])

    # Context action
    if context_pct >= 0.9:
        context_action = "warn"
    elif context_pct >= 0.75:
        context_action = "compact"
    else:
        context_action = "none"

    # Tool restriction on high failure rate
    total = len(tool_results)
    failures = sum(1 for r in tool_results if r in ("failure", "denied"))
    tool_success_rate = (total - failures) / total if total > 0 else 1.0
    tools = None
    if tool_success_rate < 0.5 and total >= 3:
        tools = ["Read", "Glob", "Grep", "Git", "Write", "Edit"]

    satisfaction = record.get("userSatisfaction", "unknown")
    stop_reason = record.get("stopReason", "unknown")
    latency_ms = record.get("latencyMs", 0)

    return {
        "workflow": record.get("activeWorkflow"),
        "advancePhase": None,
        "model": None,
        "tools": tools,
        "contextAction": context_action,
        "spawnAgent": None,
        "priority": "balanced",
        "reasoning": (
            f"Derived from historical record: stop={stop_reason}, "
            f"latency={latency_ms}ms, satisfaction={satisfaction}"
        ),
    }


def format_input(record: dict) -> str:
    """Format a DecisionRecord into a human-readable state prompt."""
    tools_called = record.get("toolsCalled", [])
    tool_results = record.get("toolResults", [])
    tool_summary = ", ".join(
        f"{t}:{r}" for t, r in zip(tools_called, tool_results)
    ) or "none"

    context_pct = int(record.get("contextUsagePercent", 0) * 100)

    lines = [
        f"User: {record.get('userMessageSummary', '')}",
        f"Workflow: {record.get('activeWorkflow') or 'none'}",
        f"Context: {context_pct}%",
        f"Tools called: {tool_summary}",
        f"Model: {record.get('modelUsed', 'unknown')}",
        f"Latency: {record.get('latencyMs', 0)}ms",
        f"Tokens: {record.get('tokenCount', 0)}",
        f"Stop: {record.get('stopReason', 'unknown')}",
    ]
    if record.get("userSatisfaction"):
        lines.append(f"Satisfaction: {record['userSatisfaction']}")

    return "\n".join(lines)


def load_records(decisions_dir: Path) -> list[dict]:
    """Load all DecisionRecord objects from *.jsonl files in decisions_dir."""
    records = []
    if not decisions_dir.exists():
        print(f"[warn] Decisions directory not found: {decisions_dir}", file=sys.stderr)
        return records

    jsonl_files = sorted(decisions_dir.glob("*.jsonl"))
    if not jsonl_files:
        print(f"[warn] No .jsonl files found in {decisions_dir}", file=sys.stderr)
        return records

    for path in jsonl_files:
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"[warn] {path}:{line_no} JSON parse error: {e}", file=sys.stderr)

    return records


def build_training_examples(records: list[dict]) -> list[dict]:
    """Convert DecisionRecords to TrainingExamples."""
    examples = []
    for record in records:
        examples.append({
            "input": format_input(record),
            "output": json.dumps(derive_decision(record)),
        })
    return examples


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Aggregate S5 training data from LocalCode decision logs"
    )
    parser.add_argument(
        "--decisions-dir",
        type=Path,
        default=Path.home() / ".localcode" / "decisions",
        help="Directory containing *.jsonl decision log files",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / ".localcode" / "training" / "s5_training_data.jsonl",
        help="Output JSONL file path",
    )
    args = parser.parse_args()

    print(f"[aggregate] Reading from: {args.decisions_dir}", file=sys.stderr)
    records = load_records(args.decisions_dir)
    print(f"[aggregate] Loaded {len(records)} decision records", file=sys.stderr)

    if not records:
        print("[aggregate] No records found — nothing to write.", file=sys.stderr)
        sys.exit(0)

    examples = build_training_examples(records)
    print(f"[aggregate] Built {len(examples)} training examples", file=sys.stderr)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")

    print(f"[aggregate] Written to: {args.output}", file=sys.stderr)
    print(f"[aggregate] Done — {len(examples)} examples ready for fine-tuning.")


if __name__ == "__main__":
    main()
