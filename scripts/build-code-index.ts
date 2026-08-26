// Build (or refresh) the CodeIndex vector index for a repo.
// Usage: bun scripts/build-code-index.ts <repo-path>
// Dispatch runs this before launching a mission so the model's first CodeIndex
// query answers from vectors instead of paying the build cost mid-run.
import { ProjectIndexer } from '../engine/index/indexer.js'

const repo = process.argv[2]
if (!repo) {
  console.error('usage: bun scripts/build-code-index.ts <repo-path>')
  process.exit(1)
}

const idx = new ProjectIndexer(repo.replaceAll('\\', '/'))
if (idx.hasEverIndexed() && !idx.isStale()) {
  console.log(`[index] up to date — ${idx.getSummary()}`)
} else {
  const r = await idx.index((m) => console.log(`[index] ${m}`))
  console.log(`[index] built: ${r.chunks} chunks from ${r.files} files (${r.skipped} unchanged)`)
}
idx.close()
