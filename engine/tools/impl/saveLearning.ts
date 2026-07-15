/**
 * SaveLearning tool — persists user preferences, corrections, and feedback to
 * the global SQLite LearningStore (~/.cynco/learnings.db). Learnings are
 * embedded for generative-agents recall and de-duplicated with a helpful bump.
 */
import type { ToolImpl } from '../types.js'
import { LearningStore, defaultLearningsDbPath } from '../../memory/learningStore.js'

function learningsDbPath(): string {
  return process.env.LOCALCODE_LEARNINGS_DB ?? defaultLearningsDbPath()
}

export const saveLearningTool: ToolImpl = {
  name: 'SaveLearning',
  description: 'Save a user preference, correction, or feedback as a persistent learning. Use this when the user corrects your approach, expresses a preference, or gives feedback about how they want things done. These learnings persist across sessions. The user can review all saved learnings with /learnings.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Type of learning: "preference", "correction", "pattern", "decision"' },
      content: { type: 'string', description: 'The learning itself — what to remember. Be specific and actionable.' },
      context: { type: 'string', description: 'Optional context about when this applies.' },
    },
    required: ['type', 'content'],
  },
  tier: 'auto',
  execute: async (input) => {
    const type = (input.type as string) || 'preference'
    const content = (input.content as string) || ''
    const context = (input.context as string) || ''
    if (!content) return { output: 'No content provided', isError: true }

    let store: LearningStore | null = null
    try {
      // Best-effort embedding so recall relevance works; keyword fallback if down.
      // Capped on a short deadline so a cold embed model can't block the tool.
      let embedding: number[] | undefined
      try {
        const { EmbedClient } = await import('../../index/embedClient.js')
        const timeoutMs = Number(process.env.LOCALCODE_RECALL_EMBED_TIMEOUT_MS ?? 4000)
        embedding = await Promise.race([
          new EmbedClient().embed(content),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
        ])
      } catch { embedding = undefined }

      store = new LearningStore(learningsDbPath())
      store.save({ type, content, context, embedding, sessionId: process.env.LOCALCODE_SESSION_ID })
      return { output: `Saved learning: ${content.slice(0, 60)}...`, isError: false }
    } catch (err) {
      return { output: `Failed to save: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    } finally {
      try { store?.close() } catch { /* ignore */ }
    }
  },
}
