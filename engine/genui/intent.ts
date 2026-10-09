/**
 * engine/genui/intent.ts — does this user message ask to SEE something the
 * dashboard should draw?
 *
 * A project chat that offers RenderUI and receives such a message sends its
 * model calls with tool_choice 'required' until a surface has drawn (at most
 * UI_FORCE_MAX_CALLS calls). Wording alone was not enough: asked "show me a
 * few different designs of the aliens", Qwen3.8-27B weighed RenderUI and
 * answered in markdown (F171). 'required' changes only llama-server's grammar
 * — the rendered prompt, and so the prefix cache, is the same as for 'auto'.
 *
 * Pure and deterministic. A false positive costs one forced tool call; a
 * false negative leaves the answer to the prompt, as before.
 */

import { UI_ACTION_PREFIX } from './actions.js'

/** Forced calls per user message before the turn falls back to 'auto'. */
export const UI_FORCE_MAX_CALLS = 3

// "show me a few different designs", "give me some options", "pitch three directions"
const ASK_VERBS = String.raw`show|give|draw|sketch|suggest|propose|pitch|list|lay out|layout|brainstorm|offer|present|generate|mock up|come up with|throw out|share|let me see|what are`
const OPTION_NOUNS = String.raw`options|designs|ideas|versions|variants|variations|alternatives|concepts|directions|approaches|choices|looks|styles|possibilities|candidates|mock-?ups|layouts|schemes|palettes|names|takes on`
const ASK_FOR_OPTIONS = new RegExp(String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}?\b(?:${OPTION_NOUNS})\b`)

// "as a table", "in a chart", "with cards", "as UI"
const AS_SURFACE = /\b(?:as|in|into|with|on)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:ui|cards?|surface|table|chart|graph|grid|widgets?|form|buttons?|checklist|timeline|dashboard view)\b/

// "make a table of the costs", "draw a chart", "give me a breakdown"
const MAKE_VERBS = String.raw`show|give|make|draw|build|put|create|lay out|plot|chart|tabulate`
const SURFACE_NOUNS = String.raw`table|chart|graph|plot|breakdown|timeline|checklist|comparison|matrix|scorecard`
const MAKE_SURFACE = new RegExp(String.raw`\b(?:${MAKE_VERBS})\b[^.?!\n]{0,40}?\b(?:${SURFACE_NOUNS})\b`)

// "compare oak and walnut", "pros and cons", "side by side"
const COMPARE = /\bcompare\b|\bcomparing\b|\bpros and cons\b|\bside[- ]by[- ]side\b/

// The user asked for words, not UI.
const OPT_OUT = /\b(?:as|in)\s+(?:plain\s+)?(?:text|prose|words)\b|\btext only\b|\bno\s+(?:ui|cards?|surfaces?|widgets?|tables?|buttons?)\b|\bwithout\s+(?:the\s+)?(?:ui|cards?|surface)\b|\bjust\s+(?:tell|say|write|explain|describe)\b/

// "don't show me options" — a negated ask is not an ask.
const NEGATED_BEFORE = /\b(?:don'?t|do not|no need to|never|stop|without)\s+(?:\w+\s+)?$/

/** The line formatUiAction writes into a click's user turn, after its echo line. */
const UI_ACTION_LINE = new RegExp('(?:^|\\n)' + UI_ACTION_PREFIX.replace(/[[\]]/g, '\\$&') + ' ')

function firstUnnegated(re: RegExp, s: string): string | null {
  const g = new RegExp(re.source, 'g')
  for (let m = g.exec(s); m; m = g.exec(s)) {
    if (!NEGATED_BEFORE.test(s.slice(Math.max(0, m.index - 24), m.index))) return m[0]
    if (m[0].length === 0) g.lastIndex++
  }
  return null
}

/**
 * Why `text` asks to see something drawn — the matched words, for the log —
 * or null when it does not. A click's own user turn never forces: the model
 * answers it and may re-render.
 */
export function uiRequestReason(text: unknown): string | null {
  if (typeof text !== 'string' || UI_ACTION_LINE.test(text)) return null
  const flat = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!flat) return null
  // Quoted text is someone else's words — the dashboard's "Save as artifact"
  // and "Show as UI" messages quote an earlier reply's opening — and must
  // neither trigger nor veto.
  const s = flat.replace(/"[^"]{0,400}"|“[^”]{0,400}”/g, ' ')
  if (OPT_OUT.test(s)) return null
  for (const re of [ASK_FOR_OPTIONS, AS_SURFACE, MAKE_SURFACE, COMPARE]) {
    const hit = firstUnnegated(re, s)
    if (hit) return hit.slice(0, 80)
  }
  return null
}
