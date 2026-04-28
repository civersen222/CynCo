
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, relative, extname } from 'path'
import { createHash } from 'crypto'
import { EmbedClient } from './embedClient.js'
import { IndexStore } from './store.js'
import { chunkFile, extractRelationships } from './chunker.js'
import type { IndexResult, IndexQuery } from './types.js'

const SOURCE_EXTS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.rb', '.cs', '.lua', '.sh'])
const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', '.cynco', '.next', 'target'])
const MAX_FILE_SIZE = 100_000 // 100KB — skip huge files

export class ProjectIndexer {
  private store: IndexStore
  private embedClient: EmbedClient
  private projectRoot: string

  constructor(projectRoot: string, ollamaBaseUrl?: string) {
    this.projectRoot = projectRoot
    const indexDir = join(projectRoot, '.cynco', 'index')
    mkdirSync(indexDir, { recursive: true })
    this.store = new IndexStore(join(indexDir, 'project.db'))
    this.embedClient = new EmbedClient(ollamaBaseUrl)
  }

  /** Full index of the project. Incremental — skips unchanged files. */
  async index(onProgress?: (msg: string) => void): Promise<{ files: number; chunks: number; skipped: number }> {
    const files = this.walkFiles()
    let chunks = 0
    let skipped = 0

    onProgress?.(`Found ${files.length} source files`)

    // Batch processing: chunk all files, then embed in batches
    const toEmbed: { chunk: any; text: string }[] = []

    for (const filePath of files) {
      const absPath = join(this.projectRoot, filePath)
      const content = readFileSync(absPath, 'utf-8')
      const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)

      // Skip if unchanged
      const existingHash = this.store.getFileHash(filePath)
      if (existingHash === fileHash) {
        skipped++
        continue
      }

      // Remove old chunks for this file
      this.store.removeFile(filePath)

      // Chunk the file
      const fileChunks = chunkFile(filePath, content)
      for (const chunk of fileChunks) {
        const embedText = `${chunk.chunkType} ${chunk.name ?? ''} in ${chunk.filePath}:\n${chunk.content.slice(0, 500)}`
        toEmbed.push({ chunk, text: embedText })
      }
    }

    onProgress?.(`Embedding ${toEmbed.length} chunks...`)

    // Embed in batches of 10
    const BATCH_SIZE = 10
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE)
      const texts = batch.map(b => b.text)

      let embeddings: number[][]
      try {
        embeddings = await this.embedClient.embedBatch(texts)
        if (i === 0) {
          console.log(`[index] First embedding: ${embeddings[0]?.length ?? 0} dimensions`)
          onProgress?.(`Embedding with ${this.embedClient.modelName} (${embeddings[0]?.length ?? 0} dims)`)
        }
      } catch (e) {
        console.log(`[index] ⚠ Embed batch failed: ${e}`)
        onProgress?.(`⚠ Embedding failed: ${e} — using keyword search only`)
        // Fallback: store with empty embedding (keyword search only)
        embeddings = texts.map(() => [])
      }

      for (let j = 0; j < batch.length; j++) {
        const { chunk } = batch[j]
        const embedding = embeddings[j] ?? []
        const chunkId = this.store.insertChunk(chunk, embedding)

        // Extract and store relationships
        const rels = extractRelationships(chunk)
        for (const rel of rels) {
          this.store.insertRelationship({
            sourceChunkId: chunkId,
            targetFile: rel.targetFile,
            relType: rel.relType,
          })
        }

        chunks++
      }

      if (i % 50 === 0 && i > 0) {
        onProgress?.(`Indexed ${i + batch.length}/${toEmbed.length} chunks...`)
      }
    }

    // Update metadata
    this.store.setMeta('last_indexed', new Date().toISOString())
    this.store.setMeta('embed_model', this.embedClient.modelName)
    this.store.setMeta('project_root', this.projectRoot)
    this.store.setMeta('file_count', String(files.length))
    this.store.setMeta('chunk_count', String(this.store.getChunkCount()))

    onProgress?.(`Done: ${chunks} chunks indexed, ${skipped} files unchanged`)
    console.log(`[index] Indexed ${chunks} chunks from ${files.length - skipped} files (${skipped} skipped)`)

    return { files: files.length, chunks, skipped }
  }

  /** Query the index. Uses vector search if available, keyword fallback otherwise. */
  async query(q: IndexQuery): Promise<IndexResult[]> {
    const topK = q.topK ?? 5

    try {
      const queryEmbedding = await this.embedClient.embed(q.query)
      const results = this.store.search(queryEmbedding, topK)
      if (results.length > 0) return results
    } catch {
      // Vector search failed — fall through to keyword
    }

    return this.store.keywordSearch(q.query, topK)
  }

  /** Check if the index is stale (files changed since last index). */
  isStale(): boolean {
    const lastIndexed = this.store.getMeta('last_indexed')
    if (!lastIndexed) return true

    // Quick check: compare file count
    const indexedCount = parseInt(this.store.getMeta('file_count') ?? '0', 10)
    const currentCount = this.walkFiles().length
    if (Math.abs(currentCount - indexedCount) > 5) return true

    // Check if last index was more than 1 hour ago
    const lastTime = new Date(lastIndexed).getTime()
    if (Date.now() - lastTime > 3600_000) return true

    return false
  }

  /** Get a summary of the index for display. */
  getSummary(): string {
    const files = this.store.getMeta('file_count') ?? '0'
    const chunks = this.store.getMeta('chunk_count') ?? '0'
    const lastIndexed = this.store.getMeta('last_indexed') ?? 'never'
    const model = this.store.getMeta('embed_model') ?? 'unknown'
    return `Index: ${chunks} chunks from ${files} files (model: ${model}, last: ${lastIndexed})`
  }

  /** Format query results as context for the LLM. */
  formatResults(results: IndexResult[]): string {
    if (results.length === 0) return ''
    return results.map(r =>
      `--- ${r.filePath}:${r.startLine}-${r.endLine} (${r.chunkType}${r.name ? ': ' + r.name : ''}) [score: ${r.score.toFixed(2)}] ---\n${r.content}`
    ).join('\n\n')
  }

  /** Re-index a single file after it's been edited. Fast — only processes one file. */
  async reindexFile(relativePath: string): Promise<void> {
    const absPath = join(this.projectRoot, relativePath)
    try {
      const content = readFileSync(absPath, 'utf-8')
      this.store.removeFile(relativePath)
      const chunks = chunkFile(relativePath, content)
      const texts = chunks.map(c => `${c.chunkType} ${c.name ?? ''} in ${c.filePath}:\n${c.content.slice(0, 500)}`)

      let embeddings: number[][]
      try {
        embeddings = await this.embedClient.embedBatch(texts)
      } catch {
        embeddings = texts.map(() => [])
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = this.store.insertChunk(chunks[i], embeddings[i] ?? [])
        const rels = extractRelationships(chunks[i])
        for (const rel of rels) {
          this.store.insertRelationship({ sourceChunkId: chunkId, targetFile: rel.targetFile, relType: rel.relType })
        }
      }

      this.store.setMeta('chunk_count', String(this.store.getChunkCount()))
      console.log(`[index] Re-indexed ${relativePath}: ${chunks.length} chunks`)
    } catch (e) {
      console.log(`[index] Re-index failed for ${relativePath}: ${e}`)
    }
  }

  close(): void {
    this.store.close()
  }

  // ─── Private ───────────────────────────────────────────────────

  private walkFiles(): string[] {
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 5) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') && entry.name !== '.cynco') continue
          if (IGNORE_DIRS.has(entry.name)) continue
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full, depth + 1)
          } else if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
            try {
              const stat = statSync(full)
              if (stat.size <= MAX_FILE_SIZE) {
                files.push(relative(this.projectRoot, full))
              }
            } catch {}
          }
        }
      } catch {}
    }
    walk(this.projectRoot, 0)
    return files
  }
}
