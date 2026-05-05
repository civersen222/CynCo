import type { ToolImpl } from '../types.js'
import { indexResearchReport } from '../../research/indexer.js'
import { EmbedClient } from '../../index/embedClient.js'
import { IndexStore } from '../../index/store.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

export const indexResearchTool: ToolImpl = {
  name: 'IndexResearch',
  description: 'Index a research report into the project vector store for future retrieval via CodeIndex.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the research report markdown file (relative to project root)',
      },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const filePath = input.file_path as string
    const fullPath = resolve(cwd, filePath)

    if (!existsSync(fullPath)) {
      return { output: `File not found: ${filePath}`, isError: true }
    }

    const dbPath = resolve(cwd, '.cynco/index/project.db')
    const dbDir = dirname(dbPath)
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    let store: IndexStore | null = null
    try {
      const content = readFileSync(fullPath, 'utf-8')
      store = new IndexStore(dbPath)
      const embedClient = new EmbedClient()
      const count = await indexResearchReport(content, filePath, store, embedClient)
      return {
        output: `Indexed ${count} research chunk${count !== 1 ? 's' : ''} from ${filePath}`,
        isError: false,
      }
    } catch (err) {
      return {
        output: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    } finally {
      store?.close()
    }
  },
}
