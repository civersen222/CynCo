// engine/engine/sessionExtras.ts
// Per-conversation cache for first-turn system-prompt extras (handoff +
// recalled memories). The prompt prefix must be byte-identical across turns
// for llama.cpp checkpoint caching: recomputing OR dropping these sections
// after turn 1 mutates the prefix and forces a full re-prefill every turn.

let cachedKey: string | null = null
let cachedExtras: string | null = null

export function resetSessionExtras(): void {
  cachedKey = null
  cachedExtras = null
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
  if (cachedKey === key && cachedExtras !== null) return cachedExtras
  cachedExtras = isFirstTurn ? await compute() : ''
  cachedKey = key
  return cachedExtras
}
