// engine/engine/sessionExtras.ts
// Per-conversation cache for first-turn system-prompt extras (handoff +
// recalled memories). The prompt prefix must be byte-identical across turns
// for llama.cpp checkpoint caching: recomputing OR dropping these sections
// after turn 1 mutates the prefix and forces a full re-prefill every turn.

// Bounded multi-conversation cache. A single slot is NOT enough: sub-agents
// call localCallModel with their own messages (their own key), and a single
// slot would let a sub-agent run evict the main conversation's entry — the
// main conversation would then re-enter with isFirstTurn=false and pin '',
// silently dropping handoff + memories and breaking the prefix.
const MAX_ENTRIES = 16
const cache = new Map<string, string>()

export function resetSessionExtras(): void {
  cache.clear()
}

/**
 * - First turn: computes extras via `compute`, caches them keyed on the
 *   conversation identity (first user message text).
 * - Later turns, same conversation: returns the cached value byte-identically.
 * - Later turns, unknown conversation (engine restarted mid-conversation):
 *   pins '' so the prefix is at least stable from now on.
 */
export async function getSessionExtras(
  key: string,
  isFirstTurn: boolean,
  compute: () => Promise<string>,
): Promise<string> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const extras = isFirstTurn ? await compute() : ''
  cache.set(key, extras)
  if (cache.size > MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return extras
}
