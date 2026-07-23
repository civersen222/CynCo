---
name: debug
description: Methodical bug hunt — reproduce, hypothesize, isolate, fix, and verify.
tools: [Read, Glob, Grep, SubAgent, CollectAgent]
---

# Systematic Debugging

Runs the built-in debugging workflow. Execution is driven by the workflow engine
through gated phases rather than free-running.

Phases:
1. **reproduce** — reproduce the bug reliably; document steps and actual vs expected.
2. **hypothesize** — form 2-3 specific root-cause hypotheses with evidence from the code.
3. **isolate** — test each hypothesis; narrow to the exact line or component.
4. **fix** — apply the minimal fix for the root cause (loops back to isolate if needed).
5. **verify** — run the full suite and re-run the original repro; confirm no regressions.
