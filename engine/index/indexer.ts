
import { execFileSync } from 'child_process'
import { readFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, relative, extname } from 'path'
import { createHash } from 'crypto'
import { EmbedClient } from './embedClient.js'
import { IndexStore } from './store.js'
import { chunkFile, chunkFileAsync, extractRelationships } from './chunker.js'
import { hybridRank } from './hybridRank.js'
import { buildRepoGraph, formatRepoMap } from './repoMapBuilder.js'
import type { IndexResult, IndexQuery } from './types.js'

/**
 * Cap a repo-map block to ~maxTokens (≈4 chars/token) so the default-on map
 * can never dominate the context budget. Truncates on a line boundary and
 * appends a marker. Documented in MANUAL.md.
 */
export function capRepoMap(map: string, maxTokens = 2000): string {
  const maxChars = maxTokens * 4
  if (map.length <= maxChars) return map
  const slice = map.slice(0, maxChars)
  const lastNl = slice.lastIndexOf('\n')
  const body = lastNl > 0 ? slice.slice(0, lastNl) : slice
  return `${body}\n[repo map truncated to ~${maxTokens} tokens]`
}

/**
 * Is `relativePath` a path the project actually contains?
 *
 * Callers hand `reindexFile` the result of `path.relative(cwd, ...)`, which for
 * a scratch file or a worktree outside the repo yields a `..\..` traversal. The
 * file is real, so the index stored it happily — and then answered queries with
 * paths the model could not open. Reject anything that leaves the tree.
 */
export function isInsideProject(relativePath: string): boolean {
  if (!relativePath) return false
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(relativePath)) return false
  return !relativePath.split(/[\\/]/).includes('..')
}

const SOURCE_EXTS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.rb', '.cs', '.lua', '.sh'])
const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', '.cynco', '.next', 'target'])
const MAX_FILE_SIZE = 100_000 // 100KB — skip huge files

/**
 * Would a full `walkFiles()` pass collect this path? `reindexFile` used to
 * accept anything the model edited, so the index accumulated `.task_outcome.json`
 * and build logs that a full re-index would then silently drop. Both entry
 * points have to agree on what the index contains.
 */
export function isIndexableSource(relativePath: string): boolean {
  if (!isInsideProject(relativePath)) return false
  return SOURCE_EXTS.has(extname(relativePath).toLowerCase())
}

/** Depth-limited recursive walk. Only used when the project is not a git repo. */
function walkFromDisk(projectRoot: string): string[] {
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        if (IGNORE_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) files.push(relative(projectRoot, full))
      }
    } catch {}
  }
  walk(projectRoot, 0)
  return files
}

/**
 * The source files that belong to this project.
 *
 * Git is the authority on what a project contains. A hand-maintained
 * IGNORE_DIRS list cannot know that a given repo vendors a sklearn corpus under
 * `benchmark/swebench-workspace`, and when it doesn't know, that corpus becomes
 * 73% of the index and drowns the real answers in semantic search.
 * `ls-files --cached --others --exclude-standard` is precisely "tracked, plus
 * untracked and not ignored". Outside a repo, fall back to walking the disk.
 */
export function listProjectFiles(projectRoot: string): string[] {
  let candidates: string[]
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    candidates = [...new Set(out.split('\0').filter(Boolean))]
  } catch {
    candidates = walkFromDisk(projectRoot)
  }

  return candidates.filter(rel => {
    if (!isIndexableSource(rel)) return false
    try {
      return statSync(join(projectRoot, rel)).size <= MAX_FILE_SIZE
    } catch {
      return false
    }
  })
}

export class ProjectIndexer {
  private store: IndexStore
  private embedClient: EmbedClient
  private projectRoot: string

  /**
   * `embedBaseUrl` is the *embedding* endpoint, not the chat one. It used to be
   * called `ollamaBaseUrl` and main.ts fed it `config.baseUrl`, which under the
   * llama.cpp provider is the llama-server port — so the indexer embedded
   * against a server with no embedding route while every other caller used the
   * default. Resolve it with `embedBaseUrlFor(config)`.
   */
  constructor(projectRoot: string, embedBaseUrl?: string) {
    this.projectRoot = projectRoot
    const indexDir = join(projectRoot, '.cynco', 'index')
    mkdirSync(indexDir, { recursive: true })
    this.store = new IndexStore(join(indexDir, 'project.db'))
    // Query vectors are only comparable to the index if they come from the same
    // model, so an existing index dictates the model rather than the process
    // default. A fresh index has nothing to say yet and keeps the default.
    this.embedClient = new EmbedClient(embedBaseUrl, this.store.getMeta('embed_model') ?? undefined)
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

      // Chunk the file (tree-sitter first, regex fallback)
      const fileChunks = await chunkFileAsync(filePath, content)
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

  /**
   * Query the index. Fuses vector + lexical (BM25) retrieval via Reciprocal
   * Rank Fusion when both are available. Set LOCALCODE_HYBRID_SEARCH=0 to fall
   * back to the legacy vector-or-keyword behavior.
   */
  async query(q: IndexQuery): Promise<IndexResult[]> {
    const topK = q.topK ?? 5
    const hybridEnabled = process.env.LOCALCODE_HYBRID_SEARCH !== '0'

    let vectorResults: IndexResult[] = []
    try {
      const queryEmbedding = await this.embedClient.embed(q.query)
      // Cast a wider candidate net when fusing so BM25 can re-rank.
      vectorResults = this.store.search(queryEmbedding, hybridEnabled ? topK * 4 : topK)
    } catch (e) {
      // Falling through to keyword search is the right recovery, but it must be
      // audible: a malformed knn query degraded retrieval to LIKE-matching for
      // weeks and looked identical to "the index had no answer".
      console.log(`[index] Vector search failed, using keyword search only: ${e}`)
    }

    if (!hybridEnabled) {
      if (vectorResults.length > 0) return vectorResults
      return this.store.keywordSearch(q.query, topK)
    }

    const keywordResults = this.store.keywordSearch(q.query, topK * 4)
    if (vectorResults.length === 0) return keywordResults.slice(0, topK)
    if (keywordResults.length === 0) return vectorResults.slice(0, topK)

    return hybridRank(vectorResults, keywordResults, q.query, topK)
  }

  /**
   * Build a repo-map block: the most important symbols by PageRank over the
   * import/reference graph. Returns '' when the graph has no resolvable edges
   * (PageRank would degenerate to uniform and add only noise).
   */
  buildRepoMap(seedFiles: string[] = [], topK = 20): string {
    const defs = this.store.getAllDefinitions()
    if (defs.length === 0) return ''
    const rels = this.store.getAllRelationships()
    const graph = buildRepoGraph(defs, rels, this.store.getIndexedFiles())
    if (graph.edgeCount() === 0) return ''
    return formatRepoMap(graph.pageRank(seedFiles, topK))
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
    if (!isIndexableSource(relativePath)) {
      console.log(`[index] Skipped re-index of ${relativePath}: not an indexable source file in this project`)
      return
    }
    const absPath = join(this.projectRoot, relativePath)
    try {
      const content = readFileSync(absPath, 'utf-8')
      this.store.removeFile(relativePath)
      const chunks = await chunkFileAsync(relativePath, content)
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
    return listProjectFiles(this.projectRoot)
  }
}
