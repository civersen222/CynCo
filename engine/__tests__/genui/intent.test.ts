/**
 * uiRequestReason decides which project-chat messages force a RenderUI
 * surface (tool_choice 'required', F171). It must catch the request that
 * failed live, the common ways of asking to see options, a comparison or a
 * table, and the dashboard's own "Show as UI" message — and must not fire on
 * thanks, negations, opt-outs, clicks, or words inside a quoted earlier reply.
 */
import { describe, expect, it } from 'vitest'
import { uiRequestReason, UI_FORCE_MAX_CALLS } from '../../genui/intent.js'
import { formatUiAction, uiActionEcho } from '../../genui/actions.js'

const LIVE = "I think we need to more fully step back you decided also on the story etc. forget all of the decisions you made alone. let's figure out the aliens. work with me and show me a few different designs of the aliens"

describe('uiRequestReason', () => {
  it('fires on the message that answered in prose live (F171)', () => {
    expect(uiRequestReason(LIVE)).toBe('show me a few different designs')
  })

  it.each([
    ['give me some options for the path', 'give me some options'],
    ['Can you pitch three directions for the sign?', 'pitch three directions'],
    ['what are my options for sealing concrete?', 'what are my options'],
    ['brainstorm names for the café', 'brainstorm names'],
    ['Suggest a few alternatives to resin', 'suggest a few alternatives'],
    ['compare oak and walnut for the frame', 'compare'],
    ['pros and cons of resin vs concrete?', 'pros and cons'],
    ['put the costs in a table', 'in a table'],
    ['show it as a table', 'as a table'],
    ['make a chart of cure temperature', 'make a chart'],
    ['give me a breakdown of the budget', 'give me a breakdown'],
    // final review: misses that now fire
    ["i don't know show me a few options", 'show me a few options'],
    ['never mind show me some options', 'show me some options'],
    ['can i see the options', 'can i see the options'],
    ['what other options are there for the roof', 'what other options are'],
    ['show me those designs again', 'show me those designs'],
    ['help me choose between pine and cedar', 'help me choose between'],
    ['which is better for the frame, oak or walnut?', 'which is better for the frame, oak or'],
    ['i want options for the roof material', 'i want options'],
    ['show me a couple of ways the river could wind through the base', 'show me a couple of ways'],
    ['any other ideas?', 'any other ideas?'],
    ['show me a few designs for the aliens and just tell me which one you would pick', 'show me a few designs'],
    ['give me three options for the base as cards, no tables', 'give me three options'],
    ['i ripped the 2" strips already. show me a few options for the edge profile, maybe 1/4" roundover', 'show me a few options'],
    ['Show your previous reply as UI with RenderUI: the same content, no new facts.', 'as ui'],
  ])('fires on %j', (text, reason) => {
    expect(uiRequestReason(text)).toBe(reason)
  })

  it.each([
    'thanks, those designs look great',
    "don't show me options, just pick one",
    'no need to show options',
    "just tell me which one you'd pick",
    'show me the options as plain text',
    'list the options in prose please',
    'write the intro paragraph',
    'I have no ideas yet',
    'what should the aliens look like?',
    'save this as an artifact',
    'how long does resin take to cure?',
    'show me how you would phrase the email',
    // final review: build, recipe and story words that are not UI requests
    'what finish should i put on the table top?',
    'there are tiny bubbles on the surface of the pond resin',
    'i poured the concrete into the form last night',
    'plant the lettuce in a grid',
    'attach the cape with buttons',
    'cut it on a table saw or by hand?',
    'i want to build a dining table from reclaimed oak, how much wood do i need?',
    'make the plot of chapter two less predictable',
    'make a table of contents for the cookbook',
    'we need a plot of land for the garden, how big?',
    'the characters need a timeline that makes sense',
    'write the next scene where the two aliens compare their ships',
    'after comparing prices i went with pine. what screws do i need?',
    'i already weighed the pros and cons, just go with cedar',
    'glue the two boards side by side and clamp them overnight?',
    'is it 3 vs 4 coats on the table top?',
    'the hero is torn between duty and love in chapter 3',
    'any ideas why the resin is cloudy?',
    'what are the names of the two main characters again?',
    'give me the directions for the bread again',
    'let me share a few ideas i had for the aliens first',
    'what are your thoughts on my three designs?',
    'what are the key ideas in the paper i added?',
    'Tighten this paragraph: The captain began to list her options',
    "you don't have to give me options",
    "i don't want you to list options, pick one",
    'show me the options in words',
    '',
    '   ',
  ])('does not fire on %j', text => {
    expect(uiRequestReason(text)).toBeNull()
  })

  it('never fires on a click, whatever its echo line or surface wording says', () => {
    const click = { type: 'ui.action' as const, surfaceId: 'path-options', action: 'choose', label: 'Show me more options', context: { option: 'A' } }
    expect(uiRequestReason(`${uiActionEcho(click)}\n${formatUiAction(click)}`)).toBeNull()
    expect(uiRequestReason(formatUiAction(click))).toBeNull()
  })

  it('ignores quoted text: an earlier reply quoted by the page neither triggers nor vetoes', () => {
    expect(uiRequestReason('Save the previous reply as an artifact named "x" using SaveArtifact. The reply to save is the earlier one that begins: "Let me show you three options".')).toBeNull()
    expect(uiRequestReason('Show your previous reply as UI with RenderUI: the same content, no new facts. The reply to show is the earlier one that begins: "Just tell me plainly, no cards".')).toBe('as ui')
    // final review: an excerpt with quotes of its own, or an odd number of
    // them, still neither triggers nor vetoes — the page's lead-in is cut
    expect(uiRequestReason('Show your previous reply as UI with RenderUI: the same content, no new facts. The reply to show is the earlier one that begins: "You asked for "no tables, just text" — here is the outline".')).toBe('as ui')
    expect(uiRequestReason('Save the previous reply as an artifact named "x" using SaveArtifact. The reply to save is the earlier one that begins: "The "side-by-side" layout works best".')).toBeNull()
    expect(uiRequestReason('Save the previous reply as an artifact named "x" using SaveArtifact. The reply to save is the earlier one that begins: "The captain turned to the envoy. "Show me the alien designs".')).toBeNull()
    expect(uiRequestReason('Save the previous reply as an artifact named "x" using SaveArtifact. The reply to save is the earlier one that begins: "For a 3/4" plywood base, here are three options; compare them".')).toBeNull()
    // the page's current wording ("the one that begins"), as sent by replyReference
    expect(uiRequestReason('Save the previous reply as an artifact named "x" using SaveArtifact. The reply to save is the one that begins: "Let me show you three options".')).toBeNull()
    expect(uiRequestReason('Show your previous reply as UI with RenderUI: the same content, no new facts. The reply to show is the one that begins: "Just tell me plainly, no cards".')).toBe('as ui')
  })

  it('ignores fenced, >-quoted and pasted-for-editing text', () => {
    expect(uiRequestReason('fix the typos:\n```\nshow me some options\n```')).toBeNull()
    expect(uiRequestReason('> show me a few designs\nwhat did you mean by this?')).toBeNull()
    expect(uiRequestReason('Continue the scene: the general says, show me your designs')).toBeNull()
  })

  it('is total over non-strings and bounded', () => {
    expect(uiRequestReason(undefined)).toBeNull()
    expect(uiRequestReason(42)).toBeNull()
    expect(uiRequestReason({ text: 'show me options' })).toBeNull()
    expect(uiRequestReason('show me ' + 'x'.repeat(10_000) + ' options')).toBeNull()
    expect(UI_FORCE_MAX_CALLS).toBe(3)
  })
})
