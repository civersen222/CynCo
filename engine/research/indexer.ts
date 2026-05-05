import { chunkResearchReport } from '../index/researchChunker.js'
import type { IndexStore } from '../index/store.js'
import type { EmbedClient } from '../index/embedClient.js'

export async function indexResearchReport(
  content: string,
  filePath: string,
  store: IndexStore,
  embedClient: EmbedClient,
): Promise<number> {
  const chunks = chunkResearchReport(filePath, content)
  let indexed = 0

  for (const chunk of chunks) {
    try {
      const embedding = await embedClient.embed(chunk.content)
      store.insertChunk(chunk, embedding)
      indexed++
    } catch (err) {
      console.log(`[research] Failed to embed chunk "${chunk.name}": ${err}`)
    }
  }

  return indexed
}
