# CynCo Documentation

CynCo (LocalCode) is a terminal-based AI coding assistant that runs entirely on
local LLMs — no cloud, no API key. Built on Stafford Beer's Viable System Model.

| Doc | For whom | What's inside |
|---|---|---|
| [USER_GUIDE.md](./USER_GUIDE.md) | Everyone | Install, launch, slash commands, modes, approvals, profiles, troubleshooting |
| [MANUAL.md](./MANUAL.md) | Engineers | Architecture, startup, model backend, VSM governance, conversation loop, tools, persistence |
| [BENCHMARKS.md](./BENCHMARKS.md) | Skeptics | How performance is measured, current (honest) numbers, how to reproduce |
| [MAXIMIZING.md](./MAXIMIZING.md) | Power users | Model/backend choice, context tuning, governance flags, profiles, big-task recipe |

**Start here:** new users → USER_GUIDE; contributors → MANUAL; evaluating whether
it works → BENCHMARKS.

Working *on* CynCo rather than with it: [`AGENTS.md`](../AGENTS.md) (subsystem map,
invariants, how to change CynCo) and [`NOW.md`](./NOW.md) (the one current objective,
next, backlog, deferred).

## The records

What was decided, what went wrong and what was measured, and where each is kept. Dated files
say what was true on their date and are not rewritten; the folder is the index.

| Record | Where | What it is evidence of |
|---|---|---|
| Failures | [`cynco-failure-log.md`](./cynco-failure-log.md) | Every CynCo failure by number (F1 onward): where, how, why, the fix and the rule it left. Cite the F-number when a change closes one. |
| Decisions | [`decisions/`](./decisions/) | Why a design is the way it is: one dated record per consequential choice, with what it costs and how it is undone. |
| Reviews | [`reviews/`](./reviews/) | Outside reviews and work orders re-checked against the code, finding by finding; the sheets of decisions they left for the owner; the 2026-07-12 dead-code audit. |
| Mission outcomes | [`../benchmark/cynco-ledger/`](../benchmark/cynco-ledger/) | One row per dispatched mission, graded against a pinned commit (`missions*.jsonl`, in 40 MB shards; its README says how to read a row). |
| Campaign verdicts | [`civkings-redesign-briefs/campaign-log.md`](./civkings-redesign-briefs/campaign-log.md) | Each campaign wave's verdict, gate result and commit range. |
| Supervision cost | [`supervision-economics-paper.md`](./supervision-economics-paper.md) | What supervising CynCo cost against what it produced, from `scripts/supervision-economics.mjs`. |
| Plans and specs | [`superpowers/plans/`](./superpowers/plans/), [`superpowers/specs/`](./superpowers/specs/) | What a piece of work set out to do when it was built. Not kept current: the package `CLAUDE.md` is. |
| Research | [`research/`](./research/) | Feasibility notes behind the Brain tier. |
