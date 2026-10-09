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
  })

  it('is total over non-strings and bounded', () => {
    expect(uiRequestReason(undefined)).toBeNull()
    expect(uiRequestReason(42)).toBeNull()
    expect(uiRequestReason({ text: 'show me options' })).toBeNull()
    expect(uiRequestReason('show me ' + 'x'.repeat(10_000) + ' options')).toBeNull()
    expect(UI_FORCE_MAX_CALLS).toBe(3)
  })
})
