# Wizard UX: Deep Research + Visual Mockups

**Date:** 2026-05-26
**Status:** Approved
**Scope:** Two enhancements to ProjectWizard — real research and blocking visual mockup gate

## Problem

The ProjectWizard has two UX gaps:

1. **Shallow research.** The brainstorm phase sends `web.search` commands, but `main.ts` handles them with a basic DuckDuckGo HTML scraper (regex on `result__snippet` divs). The sophisticated research engine at `engine/research/` — with 6 search engines, intelligent query routing, result scoring, and fallback chains — is never used by the wizard. A 31B local model's baked-in knowledge of specific products is shallow. Real multi-source research produces specific feature lists, not vague summaries.

2. **Invisible design.** Non-engineers can't evaluate a bullet-point feature list. They need to SEE what they're approving. A `MOCKUP_SYSTEM` prompt exists in `project_wizard.py` (lines 123-139) but is never used to gate the design phase. The wizard proceeds straight from design synthesis to planning without visual confirmation.

## Solution

### 1. Replace web.search Handler with Research Engine

**Current flow:**
```
project_wizard.py → web.search command (queries[])
  → main.ts case 'web.search' (lines 677-705)
    → fetch('https://html.duckduckgo.com/html/?q=...')
    → regex-extract snippets
    → emit web.search.result (plain text)
```

**New flow:**
```
project_wizard.py → web.search command (queries[])
  → main.ts case 'web.search'
    → import { routeQuery, searchWithFallback } from research/engineRouter
    → import { initEngines } from research/engines
    → import { scoreResults, deduplicateResults } from research/resultScorer
    → For each query:
      1. routeQuery(query, engines) → select best engines
      2. searchWithFallback(query, primary, engines, maxResults=5)
      3. scoreResults() → rank by relevance
      4. deduplicateResults() → remove duplicates
    → Format results with title, URL, snippet, source
    → emit web.search.result (structured text)
```

**What changes:**
- `main.ts` `web.search` handler: delete the raw DuckDuckGo fetch, import and call the research engine instead. Mirror the pattern already used by `engine/tools/impl/webSearch.ts` (lines 34-96).
- No changes to `project_wizard.py` — it already sends `web.search` commands and handles `web.search.result` events. The interface is unchanged; only the backend quality improves.
- No new protocol events or commands needed.

**Search engines now available to wizard:**
- DuckDuckGo (general web)
- Wikipedia (reference/encyclopedia)
- arXiv (academic papers)
- GitHub (code repositories)
- PubMed (biomedical)
- HuggingFace (ML models/datasets)
- SearXNG (meta-search, if configured)

### 2. Blocking Visual Mockup Gate

**Current flow:**
```
Brainstorm (Q&A) → Design synthesis → [user clicks "Looks good — plan it"] → Plan phase
```

**New flow:**
```
Brainstorm (Q&A) → Design synthesis → Auto-generate mockup → Open in browser
  → [user clicks "Looks good" or "Change something"]
  → If "Looks good" → Plan phase
  → If "Change something" → Text input → Re-generate mockup → Loop
```

**Implementation:**

After `_start_design()` completes and `state.design_summary` is set:

1. **Auto-trigger mockup generation.** Send `wizard.query` with `MOCKUP_SYSTEM` prompt + the full design summary as user content. No user action required — mockup generation starts automatically after design synthesis.

2. **Save HTML to project.** Write the response (raw HTML) to `{project_dir}/.localcode-preview.html`.

3. **Open in browser.** Use Python's `webbrowser.open()` to open the file URL. This works cross-platform (Windows, macOS, Linux).

4. **Show approval gate in TUI.** Replace the current "Show me a mockup" / "Looks good — plan it" buttons with:
   - A message: "A design preview has opened in your browser."
   - Two buttons: **"Looks good"** and **"Change something"**
   - If "Change something": show text input for feedback, re-generate mockup with feedback appended to prompt, re-open in browser, show buttons again.
   - If "Looks good": proceed to `_start_planning()`.

5. **State tracking.** Add `mockup_iteration: int` to wizard state. Cap at 5 iterations to prevent infinite loops. After 5, auto-proceed with a note.

**What changes:**
- `project_wizard.py`: Modify `_start_design()` completion handler to auto-trigger mockup. Add `_generate_mockup()` method. Add `_handle_mockup_approval()` for the gate. Modify button layout in design phase.
- No engine changes — uses existing `wizard.query` handler.
- No new protocol events — uses existing `wizard.response`.

## Files Changed

| File | Change |
|------|--------|
| `engine/main.ts` | Replace `web.search` handler (lines 677-705) with research engine calls |
| `tui/localcode_tui/screens/project_wizard.py` | Add mockup auto-generation after design, blocking approval gate, feedback loop |

## Files NOT Changed

- `engine/research/*` — already complete, no modifications needed
- `engine/tools/impl/webSearch.ts` — reference only, not modified
- `tui/localcode_tui/protocol.py` — no new event types needed
- `engine/bridge/protocol.ts` — no new event types needed

## Testing

- **Research upgrade:** Send `web.search` with queries like `["Civilization 6 game mechanics", "Crusader Kings 3 character system"]`. Verify results include titles, URLs, and come from multiple engines (not just DuckDuckGo snippets).
- **Mockup generation:** Run ProjectWizard through brainstorm + design. Verify `.localcode-preview.html` is created and browser opens automatically.
- **Blocking gate:** Verify wizard does NOT proceed to plan phase until user clicks "Looks good". Verify "Change something" re-generates and re-opens.
- **Iteration cap:** Click "Change something" 5 times. Verify auto-proceed on 6th.
- **No-browser fallback:** If `webbrowser.open()` fails (headless environment), log warning and show the HTML path in chat instead. Don't block.

## Wire Check

- [ ] `engine/research/engineRouter.ts` is imported in `main.ts` web.search handler
- [ ] `engine/research/engines/index.ts` `initEngines()` is called before routing
- [ ] `web.search.result` event still contains results (not empty)
- [ ] `project_wizard.py` `_generate_mockup()` sends `wizard.query` and handles `wizard.response`
- [ ] `.localcode-preview.html` is written to correct project directory
- [ ] "Looks good" button calls `_start_planning()`
- [ ] "Change something" button shows input and loops back to mockup generation
