import type { ToolImpl } from '../types.js'
import { ProjectIndexer } from '../../index/indexer.js'

let indexer: ProjectIndexer | null = null

export const codeIndexTool: ToolImpl = {
  name: 'CodeIndex',
  description: 'Semantic search across the codebase using the vector index. Returns the most relevant functions, classes, and code blocks matching your query. Use this BEFORE Read to find the right files — much faster than grep for understanding what exists.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for — natural language or code concepts. Examples: "combat system", "how turns are processed", "diplomacy manager"' },
      top_k: { type: 'number', description: 'Number of results to return (default: 5, max: 20)' },
    },
    required: ['query'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const query = input.query as string
    const topK = Math.min(Math.max((input.top_k as number) ?? 5, 1), 20)

    if (!indexer) {
      try {
        indexer = new ProjectIndexer(cwd)
      } catch (e) {
        return { output: `Index not available: ${e instanceof Error ? e.message : String(e)}. Run /analyze first.`, isError: true }
      }
    }

    try {
      const results = await indexer.query({ query, topK })
      if (results.length === 0) {
        return { output: `No results found for "${query}". The index may be empty — run /analyze to rebuild it.`, isError: false }
      }
      return { output: indexer.formatResults(results), isError: false }
    } catch (e) {
      return { output: `Index search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}
