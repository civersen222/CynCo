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
 * Pure and deterministic. A false positive costs up to UI_FORCE_MAX_CALLS
 * forced calls (the model must call some tool, AskUser is redirected) and
 * usually a surface nobody asked for; a false negative leaves the answer to
 * the prompt, as before. So the patterns lean precise: project chats are
 * about physical builds, recipes and stories, where "table", "surface",
 * "form", "plot", "timeline" and "compare" are ordinary words (final review).
 */
import { UI_ACTION_PREFIX } from './actions.js'

/** Forced calls per user message before the turn falls back to 'auto'. */
export const UI_FORCE_MAX_CALLS = 3

const QUANT = String.raw`(?:a few|a couple(?: of)?|some|several|different|other|more|new|alternative|alternate|possible|\d+|two|three|four|five|six)`

// An imperative counts only where it addresses the assistant — at a clause
// start or after "can you", "please", "and", "to"… — so "they offer a few
// styles" in pasted notes and "the captain has to list her options" in a
// draft do not. "show me" / "give us" address the assistant anywhere, so a
// run-on like "i don't know show me a few options" (the F171 style) still
// counts. "see" only with a requester ("can i see", "want to see").
const ADDRESS = String.raw`(?:^|[.?!,;:\-–—] |\b(?:you|u|can you|could you|would you|will you|can we|could we|let'?s|lets|please|pls|plz|and|then|just|now|also|to|maybe|so|ok|okay|alright|hey|first|instead|go ahead and|help me|help us) )`
const IMPERATIVES = String.raw`show|give|draw|sketch|suggest|propose|pitch|list|lay out|brainstorm|offer|present|generate|mock up|come up with|throw out|share`
const ASK_VERBS = String.raw`(?<=${ADDRESS})(?:${IMPERATIVES})|(?:show|give|draw|sketch|pitch|list|lay out|throw out|offer|present|suggest) (?:me|us)|let me see|lemme see|let'?s see|(?:can|could|may) (?:i|we) see|(?:want|like|love|wanna|need) to see|what are|(?:i|we) (?:want|need|would like|'?d like)`
// Weak nouns count only with a quantifier ("three directions", "a few looks"),
// so "the directions for the bread" and "how it looks" do not; "names of",
// "the main ideas" and "earlier versions" are facts about what exists.
const OPTION_NOUNS = String.raw`options|optoins|(?<!(?:main|key|central|core|big|basic|underlying) )(?:ideas|concepts)|designs|desgins|desings|(?<!(?:earlier|previous|old|older|prior|saved|last) )versions|variants|variations|alternatives|approaches|choices|styles|possibilities|candidates|mock-?ups|layouts|schemes|palettes|(?<!(?:the|their|his|her|its|our|my|your) )names(?! of)|titles|taglines|slogans|sketches|suggestions|combos|combinations|trade-?offs|takes on|${QUANT} (?:\w+ ){0,2}(?:looks|directions|ways|plans)`
const ASK_FOR_OPTIONS = new RegExp(String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}?\b(?:${OPTION_NOUNS})\b`)
// The span names what the user already has: "my designs", "feedback on", "her options".
const EXISTING = /\b(?:her|his|their|feedback|thoughts?|opinions?|critique|notes)\b|\b(?:my|our)\b(?! (?:options|choices|alternatives)\b)/

// Questions led by the noun: "what other options are there", "any ideas for",
// "options for sealing the deck?".
const NOUN_FIRST = [
  /\bwhat (?:other |more |different )*(?:options|alternatives|choices) (?:do|are|have|is)\b/,
  /\bare there (?:any |other |more )*(?:options|alternatives)\b/,
  /\bwhat are (?:some|a few|a couple of|the different|different|other|some good|some other) ways\b/,
  new RegExp(String.raw`\bwhat (?:would|could|might) (?:\w+ ){0,5}(?:designs|options|versions|layouts|looks|styles|schemes|palettes) (?:\w+ ){0,4}look like\b`),
  /^(?:(?:ok|okay|so|hmm|and|also|cool|great|nice|right)[,!.]? )?any (?:other |more |new |different )?(?:ideas|options|alternatives|suggestions)\s*[?!.]*$/,
  /(?:^|[.?!,;:] |\b(?:got|have|know of|think of) )any (?:other |more |good |better |new |different )?(?:ideas|suggestions|alternatives|options) for\b/,
  new RegExp(String.raw`^(?:(?:ok|okay|so|hmm|and|also|now|cool|great|nice|right)[,!.]? )*(?:${QUANT} )*(?:options|ideas|alternatives|suggestions|designs|variations|versions|names|looks)(?= (?:for|on|to|of|please|pls)\b|[?!.]|$)`),
]

// "as a table", "in a chart", "as UI". Words that are also physical things in
// a build (cards, surface, grid, form, buttons) count only after "as"; "on"
// and "with" only before chart/graph ("on the table" is furniture).
const AS_SURFACE = [
  /\b(?:as|in|into)\s+(?:a\s+|an\s+)?(?:ui|table|chart|graph|widgets?|checklist|timeline|matrix|dashboard view)\b(?![- ]?(?:saw|tops?|legs?|aprons?|cloth))/,
  /\bas\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:ui|cards?|surface|grid|form|buttons?|widgets?)\b/,
  /\bon\s+(?:a\s+)?(?:chart|graph)\b/,
  /\b(?:show|display)\b[^.?!]{0,30}\bin a grid\b/,
]

// "make a chart of", "give me a breakdown". An indefinite article only ("make
// the timeline consistent" edits one); "table"/"plot" only when what follows
// says it holds data ("build a dining table" is furniture, "a plot of land").
const MAKE_HEAD = String.raw`\b(?:show|give|make|draw|create|do|put together|whip up|sketch)(?: me| us)?(?: up| out)? (?:a|an)(?: \w+){0,2}? `
const MAKE_SURFACE = [
  new RegExp(MAKE_HEAD + String.raw`(?:chart|graph|breakdown|checklist|comparison|matrix|scorecard|timeline)\b`),
  new RegExp(MAKE_HEAD + String.raw`(?:table|plot)(?= (?:of (?!contents|land)|comparing|showing|listing))`),
  /\b(?:tabulate|graph|chart) (?:the|my|our|out|how|it|them|these)\b/,
]

// "compare oak and walnut", "how do X and Y compare", "help me choose between".
// Not bare "comparing", "x vs y", "torn between" or "which … or": story text
// and fact questions ("3 vs 4 coats", "torn between duty and love").
const COMPARE = [
  /(?:^|[.?!,;:] |\b(?:can you|could you|would you|will you|please|pls|plz|help me|let'?s|now|and|then|also|to|just|me) )compare\b/,
  /\bhow (?:do|does|did|would|will) [^.?!]{1,60} compare\b/,
  /\b(?:a|the) (?:quick |side[- ]by[- ]side |cost |price )?comparison (?:of|between)\b/,
  /\bhelp (?:me|us) (?:to )?(?:choose|decide|pick) between\b/,
  /\bwhich (?:\w+ )?(?:is|would be|do you think is|would you say is) (?:better|best|stronger|cheaper)\b[^.?!]{0,60}\bor\b/,
  /\bwhich (?:\w+ )?would you (?:recommend|pick|choose|go with)\b[^.?!]{0,80}\bor\b/,
  /\b(?:do|make|give|show)(?: me| us)? a side[- ]by[- ]side\b/,
  /\b(?:show|see|view|display|compare|lay out|put|line up)\b[^.?!]{0,40}\bside[- ]by[- ]side\b/,
]
const PROS_CONS = /\bpros and cons\b/
const PROS_CONS_KNOWN = /\b(?:weighed|know|knew|considered|thought (?:about|through)|went through|aware of|read|seen|listed)\s+(?:all\s+)?(?:the\s+)?$/

// Format opt-outs. "just tell me which you'd pick" after "show me a few
// designs" asks for a recommendation too, and "no tables" next to "as cards"
// names the surface it wants — neither vetoes the message.
const OPT_OUT = /\b(?:as|in)\s+(?:plain\s+)?(?:text|prose|words)\b|\btext only\b|\bno\s+(?:ui|cards?|surfaces?|widgets?)\b|\bwithout\s+(?:the\s+)?(?:ui|cards?|surface)\b/

// The negator must govern the verb: "don't show", "don't need to show",
// "you don't have to give" — not "i don't know show me" or "never mind show me".
const NEGATED_BEFORE = /\b(?:don'?t|do not|didn'?t|doesn'?t|does not|no need to|never|stop|without|can'?t|cannot|won'?t)\s+(?:(?:need|have|want|bother|ever|really|even|just)\s+)?(?:(?:you|me)\s+)?(?:to\s+)?$/

/** The line formatUiAction writes into a click's user turn, after its echo line. */
const UI_ACTION_LINE = new RegExp('(?:^|\\n)' + UI_ACTION_PREFIX.replace(/[[\]]/g, '\\$&') + ' ')

// The dashboard's own messages quote an earlier reply after this phrase. The
// excerpt may hold a '"' of its own (12" frames, dialogue cut mid-quote), so
// it is cut off here rather than by pairing quotes.
const PAGE_QUOTE = / the reply to (?:save|show) is the (?:earlier )?one that begins: .*$/
// "Tighten this paragraph: <pasted text>" — the text after the colon is the user's material.
const EDIT_DIRECTIVE = /\b(?:tighten|edit|rewrite|proofread|polish|continue|improve|shorten|expand|translate|fix)(?: (?:up|this|it|the|my|our)){1,2}(?: (?:paragraph|scene|chapter|draft|text|passage|section|story|intro|page|lines?|sentences?|dialogue|bit))?: .*$/

function firstUnvetoed(re: RegExp, s: string, veto: RegExp = NEGATED_BEFORE, existing = false): string | null {
  const g = new RegExp(re.source, 'g')
  for (let m = g.exec(s); m; m = g.exec(s)) {
    if (!veto.test(s.slice(Math.max(0, m.index - 32), m.index)) && !(existing && EXISTING.test(m[0]))) return m[0]
    if (m[0].length === 0) g.lastIndex++
  }
  return null
}

const firstOf = (res: RegExp[], s: string): string | null => {
  for (const re of res) {
    const h = firstUnvetoed(re, s)
    if (h) return h
  }
  return null
}

/**
 * Why `text` asks to see something drawn — the matched words, for the log —
 * or null when it does not. Never for a click's own user turn (the model
 * answers it and may re-render); blind to quoted, fenced, `>`-quoted and
 * pasted-for-editing text, which is someone else's words.
 */
export function uiRequestReason(text: unknown): string | null {
  if (typeof text !== 'string' || UI_ACTION_LINE.test(text)) return null
  const own = text.replace(/```[\s\S]*?```/g, ' ').replace(/^>.*$/gm, ' ')
  const flat = own.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!flat) return null
  // A quote never opens right after a digit: 2" is an inch mark.
  const s = flat.replace(PAGE_QUOTE, ' ').replace(/(?<!\d)"[^"]{0,400}"|“[^”]{0,400}”/g, ' ').replace(EDIT_DIRECTIVE, ' ')
  if (OPT_OUT.test(s)) return null
  const hit = firstUnvetoed(ASK_FOR_OPTIONS, s, NEGATED_BEFORE, true)
    ?? firstOf(NOUN_FIRST, s)
    ?? firstOf(AS_SURFACE, s)
    ?? firstOf(MAKE_SURFACE, s)
    ?? firstUnvetoed(PROS_CONS, s, PROS_CONS_KNOWN)
    ?? firstOf(COMPARE, s)
  return hit ? hit.trim().slice(0, 80) : null
}
