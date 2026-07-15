import { existsSync } from 'fs'
import { LearningStore, defaultLearningsDbPath } from './learningStore.js'

type RecalledMemory = {
  type: string
  content: string
  context?: string
  confidence?: string
  score?: number
}

/**
 * Recall learnings from the SQLite LearningStore using generative-agents
 * ranking. Replaces the former python3 scripts/recall.py subprocess path.
 * Returns [] when no db exists yet (fresh install) — the only silent-empty
 * case; genuine failures are logged.
 */
export async function recallMemories(
  query: string,
  k = 5,
  dbPath: string = defaultLearningsDbPath(),
): Promise<RecalledMemory[]> {
  if (!existsSync(dbPath)) return []
  let store: LearningStore | null = null
  try {
    store = new LearningStore(dbPath)
    // Optional embedding for relevance; keyword fallback if the embed server
    // is down (recall must never block the turn on the network).
    let queryEmbedding: number[] | undefined
    try {
      const { EmbedClient } = await import('../index/embedClient.js')
      // Cap the embed on a short deadline: recall must never block the turn on
      // the network (cold-model loads can take seconds). Fall back to lexical.
      const timeoutMs = Number(process.env.LOCALCODE_RECALL_EMBED_TIMEOUT_MS ?? 4000)
      queryEmbedding = await Promise.race([
        new EmbedClient().embed(query),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ])
    } catch { queryEmbedding = undefined }

    const results = store.recall(query, k, queryEmbedding)
    return results.map(r => ({
      type: r.type,
      content: r.content,
      context: r.context || undefined,
      confidence: r.promoted ? 'high' : undefined,
      score: r.score,
    }))
  } catch (err) {
    console.log(`[recall] learning recall failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  } finally {
    try { store?.close() } catch { /* ignore */ }
  }
}

/** Format recalled memories into a system prompt section. */
export function formatRecalledMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return ''
  const lines = ['## Recalled Learnings', '']
  for (const m of memories) {
    const conf = m.confidence ? ` (${m.confidence} confidence)` : ''
    lines.push(`- **[${m.type}]**${conf}: ${m.content}`)
    if (m.context) lines.push(`  _Context: ${m.context}_`)
  }
  return lines.join('\n')
}
