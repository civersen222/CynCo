---
name: plan
description: Plan and execute — create a step-by-step plan, execute each step, verify before moving on.
tools: [Read, Glob, Grep, CodeIndex]
---

# Plan and Execute

Runs the built-in planning workflow. Execution is driven by the workflow engine
through gated phases rather than free-running. Editing tools unlock only after the
plan is written.

Phases:
1. **create_plan** — read the relevant files, then output a numbered plan as TEXT. Do not edit yet.
2. **execute_step** — carry out the current step precisely; complete only that step.
3. **verify_step** — verify the step (tests, output, inspection), then continue or finish.
