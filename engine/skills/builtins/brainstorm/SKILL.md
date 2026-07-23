---
name: brainstorm
description: Guided ideation — understand context, explore approaches, propose, refine, write a spec.
tools: [Read, Glob, Grep, Git, SubAgent, CollectAgent]
---

# Brainstorming

Runs the built-in brainstorming workflow. Execution is driven by the workflow engine
through gated phases rather than free-running.

Phases:
1. **understand** — ask ONE clarifying question at a time; explore existing patterns. No solutions yet.
2. **explore** — lay out 2-3 approaches with trade-offs and effort; recommend one.
3. **propose** — present a concrete design (architecture, components, data flow, interfaces).
4. **refine** — incorporate feedback and re-present the design.
5. **spec** — write the final design spec (goal, architecture, file structure, interfaces, testing).
