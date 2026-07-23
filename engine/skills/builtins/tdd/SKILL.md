---
name: tdd
description: Red-green-refactor TDD cycle — write a failing test, make it pass, then refactor.
tools: [Read, Glob, Grep, Write, Edit, SubAgent, CollectAgent, Bash]
---

# Test-Driven Development

Runs the built-in TDD workflow. Execution is driven by the workflow engine, which
advances through gated phases — you do not free-run; each phase has its own tools
and a gate that must be satisfied before advancing.

Phases:
1. **write_test** — write a failing test only; no production code yet.
2. **run_test_fail** — run the suite and confirm the new test FAILS (proves it tests something).
3. **implement** — write the minimum production code to make the test pass.
4. **run_test_pass** — run the suite and confirm the test PASSES with no regressions.
5. **refactor** — clean up without changing behavior; commit or start the next cycle.
