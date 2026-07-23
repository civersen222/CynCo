---
name: research
description: Deep multi-source research — scope, decompose, gather, synthesize, report with citations.
tools: [Read, Glob, Grep, CodeIndex, WebSearch, SubAgent, CollectAgent, WebFetch, Write, IndexResearch]
---

# Deep Research

Runs the built-in research workflow. Execution is driven by the workflow engine
through gated phases rather than free-running.

Phases:
1. **scope** — clarify the research question and check the code index for prior work.
2. **decompose** — break the question into 3-7 sub-queries with the right engine for each.
3. **gather** — spawn researcher sub-agents per sub-query (parallel), then collect their findings.
4. **synthesize** — corroborate, flag contradictions, and identify gaps; loop back to gather if critical gaps remain.
5. **report** — produce an inline summary plus a full report saved under .cynco/research/.
6. **index** — index the report into the vector store so findings are discoverable later.
