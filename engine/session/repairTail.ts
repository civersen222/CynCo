// engine/session/repairTail.ts
// A journal cut mid-turn (the daemon paused or killed the run) ends with an assistant
// message whose tool_use blocks never got their tool_result. The chat template rejects
// that shape, and the model would otherwise believe the calls ran. This synthesizes the
// missing results so a resumed conversation is well-formed and honest about the gap.
import type { Message, ToolResultBlock, ToolUseBlock } from '../types.js'

export const INTERRUPTED_TOOL_RESULT =
  'This tool call was interrupted before it ran (the run was paused or stopped). Re-issue it if you still need the result.'

/** The user message that closes a dangling assistant tool_use turn, or null when the tail is clean. */
export function danglingToolResults(messages: Message[]): Message | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  const uses = (last.content ?? []).filter((b): b is ToolUseBlock => (b as { type?: string }).type === 'tool_use')
  if (uses.length === 0) return null
  const results: ToolResultBlock[] = uses.map((u) => ({
    type: 'tool_result',
    tool_use_id: u.id,
    content: INTERRUPTED_TOOL_RESULT,
    is_error: true,
  }))
  return { role: 'user', content: results }
}
