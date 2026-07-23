---
name: critique
description: Iterative Contextual Refinement — generate a solution, critique it harshly, refine. Repeat.
tools: [Read, Grep, Glob, SubAgent, CollectAgent]
---

# ICR Critique

Runs the built-in critique workflow. Execution is driven by the workflow engine
through gated phases rather than free-running.

Phases:
1. **generate** — produce a complete first solution; do your best work.
2. **critique** — switch to critic mode; find bugs, edge cases, unclear naming; score 1-10 and list issues.
3. **refine** — address every issue found. Finish if the score is 8+ with only minor issues, else loop back to generate.
