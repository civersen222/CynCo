---
name: review
description: Structured code review — gather context, analyze quality, produce a report.
tools: [Read, Glob, Grep, Bash, SubAgent, CollectAgent]
---

# Code Review

Runs the built-in code-review workflow. Execution is driven by the workflow engine
through gated phases rather than free-running.

Phases:
1. **gather** — read the changed files and surrounding code; check git history; scope the review. No judgments yet.
2. **analyze** — assess correctness, clarity, performance, security, and test coverage; classify issues by severity.
3. **report** — write an actionable report grouped by severity, with file/line refs and concrete suggestions.
