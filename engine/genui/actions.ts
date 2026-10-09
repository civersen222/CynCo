/**
 * engine/genui/actions.ts — a dashboard click as the model's next user turn.
 *
 * The page sends `ui.action` with the action name the model put on the Button,
 * the Button's context and the surface's current input values. The loop makes
 * one user message out of it: a short echo line first (what the page showed as
 * the user's bubble, so a reopened transcript reads the same) and the full
 * structured body second. Every section is bounded: the command schema already
 * caps the frame, and this caps the text the model sees again.
 */
import type { UiActionCommand } from '../bridge/protocol.js'

/** Per-section cap on the text handed to the model. */
export const UI_ACTION_SECTION_CAP = 4096

export const UI_ACTION_PREFIX = '[UI action]'

/**
 * The action a FollowUps chip sends. The chip's text IS the user's next
 * question, so the model receives it verbatim — no "[UI action]" envelope —
 * and it rides the same queue as a Button click, because a `user.message`
 * sent while the turn that drew the chips is still running is dropped by
 * the busy guard (design review, parity lens).
 */
export const UI_FOLLOWUP_ACTION = 'followup'

/** A chip click: the `followup` action carrying non-empty text. */
export function isFollowUp(a: UiActionCommand): boolean {
  return a.action === UI_FOLLOWUP_ACTION && typeof a.userMessage === 'string' && a.userMessage.trim() !== ''
}

function bounded(value: unknown): string {
  let s: string
  try { s = JSON.stringify(value) ?? 'null' } catch { s = String(value) }
  if (s.length <= UI_ACTION_SECTION_CAP) return s
  return `${s.slice(0, UI_ACTION_SECTION_CAP)}…(${s.length - UI_ACTION_SECTION_CAP} bytes omitted)`
}

/** What the chat pane shows as the user's own bubble for a click. */
export function uiActionEcho(a: UiActionCommand): string {
  const msg = typeof a.userMessage === 'string' ? a.userMessage.trim() : ''
  if (msg) return msg
  const label = typeof a.label === 'string' ? a.label.trim() : ''
  return `▶ ${label || a.action}`
}

/** The structured body the model reads. */
export function formatUiAction(a: UiActionCommand): string {
  const lines = [`${UI_ACTION_PREFIX} "${(a.label ?? a.action).slice(0, 200)}" → action "${a.action}" on surface "${a.surfaceId}"`]
  if (a.context && Object.keys(a.context).length) lines.push(`context: ${bounded(a.context)}`)
  if (a.state && Object.keys(a.state).length) lines.push(`input values: ${bounded(a.state)}`)
  else lines.push('input values: (none)')
  lines.push('Respond to this click. To change the surface, call RenderUI again with the same "surface" id.')
  return lines.join('\n')
}
