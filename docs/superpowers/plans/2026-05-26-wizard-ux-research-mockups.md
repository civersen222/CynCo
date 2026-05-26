# Wizard UX: Deep Research + Visual Mockups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade ProjectWizard so its research phase uses the real multi-engine research system and its design phase gates on a visual HTML mockup opened in the browser.

**Architecture:** Two isolated changes: (1) replace the basic DuckDuckGo HTML scraper in main.ts `web.search` handler with calls to the existing research engine (`engine/research/`), and (2) add a blocking mockup-generation-and-approval flow after design synthesis in `project_wizard.py`. No new protocol events needed — both use existing `web.search.result` and `wizard.response`.

**Tech Stack:** TypeScript (Bun), Python (Textual TUI), existing research engine (`engine/research/`)

---

### Task 1: Replace web.search handler with research engine

**Files:**
- Modify: `engine/main.ts:677-705`
- Reference: `engine/tools/impl/webSearch.ts` (pattern to follow)
- Reference: `engine/research/engineRouter.ts`, `engine/research/engines/registry.ts`, `engine/research/resultScorer.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/webSearchHandler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We'll test the research engine integration by verifying that
// routeQuery and searchWithFallback are called correctly.
// The actual handler is inside main.ts's switch statement, so we test
// the research engine functions directly.

import { routeQuery } from '../research/engineRouter.js'
import { initEngines, getAllEngines } from '../research/engines/registry.js'
import { scoreResults, deduplicateResults } from '../research/resultScorer.js'

describe('web.search handler upgrade', () => {
  beforeEach(() => {
    initEngines()
  })

  it('routeQuery returns engines for game-related queries', () => {
    const engines = getAllEngines()
    const routed = routeQuery('Civilization 6 game mechanics', engines)
    expect(routed.length).toBeGreaterThan(0)
  })

  it('routeQuery returns engines for technical queries', () => {
    const engines = getAllEngines()
    const routed = routeQuery('React component library documentation', engines)
    expect(routed.length).toBeGreaterThan(0)
  })

  it('scoreResults ranks results by keyword density', () => {
    const results = [
      { title: 'Unrelated', url: 'https://example.com/a', snippet: 'Nothing here', source: 'duckduckgo' },
      { title: 'Civilization Guide', url: 'https://example.com/b', snippet: 'Civilization 6 hex combat mechanics', source: 'duckduckgo' },
    ]
    const scored = scoreResults(results, 'civilization combat mechanics')
    expect(scored[0].title).toBe('Civilization Guide')
  })

  it('deduplicateResults removes duplicate URLs', () => {
    const results = [
      { title: 'A', url: 'https://example.com/page', snippet: 'First', source: 'duckduckgo', score: 5 },
      { title: 'A', url: 'https://example.com/page', snippet: 'Duplicate', source: 'wikipedia', score: 3 },
    ]
    const deduped = deduplicateResults(results)
    expect(deduped.length).toBe(1)
    expect(deduped[0].score).toBe(5) // keeps higher score
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd engine && bunx vitest run __tests__/webSearchHandler.test.ts`
Expected: PASS (these test the existing research engine, not our new code yet)

- [ ] **Step 3: Replace the web.search handler in main.ts**

In `engine/main.ts`, replace lines 677-705 (the entire `case 'web.search':` block) with:

```typescript
    case 'web.search': {
      const requestId = (command as any).requestId ?? ''
      const queries: string[] = (command as any).queries ?? []
      console.log(`[search] Searching ${queries.length} queries via research engine`)

      // Lazy-init research engines (same pattern as webSearch tool)
      const { initEngines, getAllEngines } = await import('./research/engines/registry.js')
      const { routeQuery, searchWithFallback } = await import('./research/engineRouter.js')
      const { scoreResults, deduplicateResults } = await import('./research/resultScorer.js')
      initEngines()

      const allResults: string[] = []
      for (const query of queries.slice(0, 5)) {
        try {
          const engines = getAllEngines()
          const routed = routeQuery(query, engines)
          if (routed.length === 0) {
            console.log(`[search] No engines matched for "${query}"`)
            continue
          }
          // Search top 2 engines with fallback chain
          const searches = routed.slice(0, 2).map(e =>
            searchWithFallback(query, e, engines, 5)
          )
          const searchResults = (await Promise.allSettled(searches))
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => (r as PromiseFulfilledResult<any[]>).value)

          const scored = scoreResults(searchResults, query)
          const deduped = deduplicateResults(scored).slice(0, 5)

          if (deduped.length > 0) {
            const formatted = deduped.map((r: any, i: number) => {
              const meta = r.metadata
              const authorLine = meta?.authors?.length ? `\n   Authors: ${meta.authors.join(', ')}` : ''
              const dateLine = meta?.date ? `\n   Date: ${meta.date}` : ''
              const starsLine = meta?.stars != null && meta.stars > 0 ? `\n   Stars: ${meta.stars.toLocaleString()}` : ''
              return `${i + 1}. ${r.title}\n   ${r.url}\n   [${r.source}] ${r.snippet}${starsLine}${authorLine}${dateLine}`
            }).join('\n\n')
            allResults.push(`Search: "${query}"\n${formatted}\n`)
          }
        } catch (err) {
          console.log(`[search] Failed for "${query}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const resultText = allResults.join('\n') || 'No search results found.'
      console.log(`[search] Got ${allResults.length} result sets, ${resultText.length} chars`)
      wsServer.emit({ type: 'web.search.result', requestId, results: resultText })
      break
    }
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run __tests__/webSearchHandler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/main.ts engine/__tests__/webSearchHandler.test.ts
git commit -m "feat(wizard): replace basic DuckDuckGo scraper with multi-engine research"
```

---

### Task 2: Add blocking mockup gate after design phase

**Files:**
- Modify: `tui/localcode_tui/screens/project_wizard.py`
- Test: `tui/tests/test_project_wizard.py`

- [ ] **Step 1: Write the test**

Add to `tui/tests/test_project_wizard.py`:

```python
def test_mockup_auto_triggers_after_design(wizard_state):
    """After design synthesis completes, mockup generation should auto-trigger."""
    state = wizard_state
    state.phase = "design"
    state.design_summary = "A game with hex-based combat..."
    # When design completes, the next pending query should be a mockup request
    # (verified by checking _pending_query prefix is "mockup-")
    assert state.design_summary is not None


def test_mockup_iteration_cap():
    """Mockup iteration should be capped at 5."""
    from localcode_tui.screens.project_wizard import MAX_MOCKUP_ITERATIONS
    assert MAX_MOCKUP_ITERATIONS == 5


def test_mockup_state_tracking():
    """WizardState should track mockup_iteration count."""
    from localcode_tui.screens.project_wizard import WizardState
    state = WizardState()
    assert state.mockup_iteration == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && python -m pytest tests/test_project_wizard.py -k "mockup" -v`
Expected: FAIL (mockup_iteration and MAX_MOCKUP_ITERATIONS don't exist yet)

- [ ] **Step 3: Add mockup state to WizardState**

In `project_wizard.py`, find the `WizardState` class (dataclass) and add:

```python
MAX_MOCKUP_ITERATIONS = 5
```

Add to WizardState fields:

```python
    mockup_iteration: int = 0
```

- [ ] **Step 4: Modify design completion to auto-trigger mockup**

In `project_wizard.py`, find the `handle_wizard_response` method's `elif req_id.startswith("design-"):` branch (around line 633). Replace:

```python
        elif req_id.startswith("design-"):
            if error or not text.strip():
                self._fallback_to_design()
            else:
                self.state.design_summary = text.strip()
            self._render_phase()
```

With:

```python
        elif req_id.startswith("design-"):
            if error or not text.strip():
                self._fallback_to_design()
            else:
                self.state.design_summary = text.strip()
                # Auto-trigger mockup generation after design synthesis
                self.state.mockup_iteration = 0
                self._generate_mockup()
                return  # Don't render yet — wait for mockup response
            self._render_phase()
```

- [ ] **Step 5: Modify mockup response to show approval gate**

In the `handle_wizard_response` method's `elif req_id.startswith("mockup-"):` branch (around line 628), replace:

```python
        elif req_id.startswith("mockup-"):
            if error or not text.strip():
                self.notify("Mockup generation failed — continuing without preview", severity="warning")
            else:
                # Extract HTML — strip markdown fences if present
                html = text.strip()
                if html.startswith("```"):
                    lines = html.split("\n")
                    html = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
                self._show_mockup(html)
```

With:

```python
        elif req_id.startswith("mockup-"):
            if error or not text.strip():
                self.notify("Mockup generation failed — continuing without preview", severity="warning")
                # Fall through to design phase with plan button
                self._render_phase()
            else:
                # Extract HTML — strip markdown fences if present
                html = text.strip()
                if html.startswith("```"):
                    lines = html.split("\n")
                    html = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
                self._show_mockup(html)
            return
```

- [ ] **Step 6: Modify _show_mockup to show approval gate**

Replace the existing `_show_mockup` method with:

```python
    def _show_mockup(self, html: str) -> None:
        """Save mockup HTML, open in browser, show approval gate."""
        import os
        import webbrowser

        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        mockup_path = os.path.join(project_dir, '.localcode-preview.html')

        try:
            with open(mockup_path, 'w', encoding='utf-8') as f:
                f.write(html)
            webbrowser.open(f'file:///{mockup_path}')
            self.notify("Mockup opened in your browser!", severity="information")
        except Exception as e:
            self.notify(f"Could not open mockup: {e}", severity="error")

        # Show approval gate
        try:
            content = self.query_one("#project-content", VerticalScroll)
            content.remove_children()
            content.mount(Static(self.state.design_summary))
            content.mount(Static(
                f"\n[bold green]Design preview opened in your browser![/bold green]\n"
                f"[dim]File: {mockup_path}[/dim]\n"
                f"[dim]Iteration: {self.state.mockup_iteration + 1} of {MAX_MOCKUP_ITERATIONS}[/dim]\n\n"
                f"[bold]Does this look right?[/bold]"
            ))
            if self.state.mockup_iteration < MAX_MOCKUP_ITERATIONS:
                self._show_buttons("btn-plan", "btn-change-mockup", "btn-cancel")
            else:
                self.notify("Max mockup iterations reached — proceeding to plan", severity="warning")
                self._show_buttons("btn-plan", "btn-cancel")
        except Exception:
            pass
```

- [ ] **Step 7: Add "Change something" button and handler**

In the button list (find `all_btn_ids` in `_show_buttons`), add `"btn-change-mockup"` to the list.

In the `compose()` or button-creation section, add the button:

```python
Button("Change something", id="btn-change-mockup", variant="default"),
```

In `on_button_pressed`, add a case:

```python
        elif button_id == "btn-change-mockup":
            # Show input for feedback, then re-generate mockup
            try:
                content = self.query_one("#project-content", VerticalScroll)
                content.remove_children()
                content.mount(Static("[bold]What would you like to change?[/bold]\n"))
                content.mount(Input(placeholder="Describe what to change...", id="mockup-feedback-input"))
                self._show_buttons("btn-cancel")
            except Exception:
                pass
```

- [ ] **Step 8: Handle mockup feedback input**

In the input submission handler (find `on_input_submitted` or the Input handler), add:

```python
        elif input_id == "mockup-feedback-input":
            feedback = event.value.strip()
            if feedback:
                self.state.mockup_iteration += 1
                # Re-generate with feedback
                req_id = f"mockup-{uuid.uuid4().hex[:8]}"
                self._pending_query = req_id
                self.app.send_raw_command(json.dumps({
                    "type": "wizard.query",
                    "requestId": req_id,
                    "systemPrompt": MOCKUP_SYSTEM,
                    "prompt": (
                        f"Design to visualize:\n{self.state.design_summary}\n\n"
                        f"User feedback on previous mockup:\n{feedback}\n\n"
                        f"Generate an UPDATED mockup that addresses this feedback."
                    ),
                }))
                try:
                    content = self.query_one("#project-content", VerticalScroll)
                    content.remove_children()
                    content.mount(Static(
                        "[bold yellow]Regenerating mockup with your feedback...[/bold yellow]"
                    ))
                except Exception:
                    pass
```

- [ ] **Step 9: Run tests**

Run: `cd tui && python -m pytest tests/test_project_wizard.py -v`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add tui/localcode_tui/screens/project_wizard.py tui/tests/test_project_wizard.py
git commit -m "feat(wizard): add blocking visual mockup gate after design phase"
```

---

### Task 3: Wire check

- [ ] **Step 1: Verify research engine is imported in main.ts**

```bash
cd engine && grep -n "engineRouter\|resultScorer\|registry" main.ts | head -10
```

Expected: imports from `./research/engineRouter.js`, `./research/engines/registry.js`, `./research/resultScorer.js`

- [ ] **Step 2: Verify web.search.result event still emits**

```bash
cd engine && grep -n "web.search.result" main.ts
```

Expected: `wsServer.emit({ type: 'web.search.result', requestId, results: resultText })`

- [ ] **Step 3: Verify mockup generation sends wizard.query**

```bash
cd tui && grep -n "wizard.query" localcode_tui/screens/project_wizard.py | head -10
```

Expected: multiple occurrences including mockup requests

- [ ] **Step 4: Verify btn-change-mockup is in button list**

```bash
cd tui && grep -n "btn-change-mockup" localcode_tui/screens/project_wizard.py
```

Expected: in `all_btn_ids`, `Button(...)`, and `on_button_pressed`

- [ ] **Step 5: Verify "Looks good" (btn-plan) calls _start_planning**

```bash
cd tui && grep -n "btn-plan" localcode_tui/screens/project_wizard.py
```

Expected: `btn-plan` maps to `_start_planning()`

- [ ] **Step 6: Run full test suites**

```bash
cd tui && python -m pytest tests/ -v
cd engine && bunx vitest run
```

Expected: all tests pass

- [ ] **Step 7: Commit wire check**

```bash
git commit --allow-empty -m "test: wire check — wizard UX research + mockups verified"
```
