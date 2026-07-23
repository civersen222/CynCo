/**
 * Context hygiene: deflate the autoregressive prior that creates a tool-call
 * attractor by removing gate-certified-redundant Read+DENIED exchange pairs.
 * Pure function — the caller swaps the returned array into its live context.
 * Safety: only prunes assistant tool_use blocks whose read signature is in
 * `redundantSigs`, together with the matching tool_result (by tool_use_id).
 * Keeps the most recent such exchange for continuity; inserts ONE marker.
 */
type Msg = { role: string; content: any }
type SigOf = (toolName: string, input: any) => string | null

const MARKER =
  '[context-hygiene] Pruned redundant re-read attempts that returned no new information. ' +
  'You have already read the relevant files — write the file now.'

export function pruneRedundantReads(messages: Msg[], redundantSigs: Set<string>, sigOf: SigOf): Msg[] {
  if (redundantSigs.size === 0) return messages

  // A redundant exchange = an assistant message whose SOLE tool_use call is a
  // certified-redundant read, immediately followed by the matching tool_result
  // user message. Reasoning models (qwen3.6 etc.) emit a `thinking` block
  // alongside the tool_use, so the turn may carry more than one content block —
  // we key off the tool_use blocks, not total content length. Turns with more
  // than one tool_use (a read plus another action) are left untouched.
  const isRedundantAssistant = (m: Msg): string | null => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return null
    const toolUses = m.content.filter((b: any) => b?.type === 'tool_use')
    if (toolUses.length !== 1) return null
    const b = toolUses[0]
    const sig = sigOf(b.name, b.input)
    return sig && redundantSigs.has(sig) ? b.id : null
  }

  // Collect indices of redundant (assistant, result) pairs.
  const pairs: { a: number; r: number }[] = []
  for (let i = 0; i < messages.length - 1; i++) {
    const id = isRedundantAssistant(messages[i])
    if (!id) continue
    const next = messages[i + 1]
    const matches = next.role === 'user' && Array.isArray(next.content) &&
      next.content.some((b: any) => b?.type === 'tool_result' && b.tool_use_id === id)
    if (matches) { pairs.push({ a: i, r: i + 1 }); i++ }
  }

  if (pairs.length <= 1) return messages // nothing to collapse (0 or 1 — keep it)

  // Keep the most recent redundant pair; prune all earlier ones.
  const keep = pairs[pairs.length - 1]
  const pruned = new Set<number>()
  for (const p of pairs.slice(0, -1)) { pruned.add(p.a); pruned.add(p.r) }

  const out: Msg[] = []
  let markerInserted = false
  for (let i = 0; i < messages.length; i++) {
    if (pruned.has(i)) {
      if (!markerInserted) { out.push({ role: 'user', content: MARKER }); markerInserted = true }
      continue
    }
    out.push(messages[i])
  }
  return out
}
