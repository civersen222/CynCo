/**
 * Eval worker: runs one CodeIndex query against one repo's existing index and
 * prints JSON {files, scores} (or {skipped}) as the last stdout line.
 *
 * Runs under bun (bun:sqlite). Never full-builds a missing index — building a
 * foreign repo's index is an hour of embedding the harness must not spend.
 *
 * Before/after seam: prefers ProjectIndexer.searchFormatted (the symbol-first
 * pipeline) when it exists and parses file paths from its formatted output;
 * otherwise falls back to the structured query() results (the BEFORE pipeline).
 *
 * Usage: bun run scripts/codeindex-eval-worker.ts <repoRoot> <query> [topK]
 */
import { ProjectIndexer } from '../engine/index/indexer.js'

const [repoRoot, query, topKArg] = process.argv.slice(2)
const topK = parseInt(topKArg ?? '3', 10) || 3

function filesFromFormatted(out: string, topN: number): { files: string[]; scores: (number | null)[] } {
  const files: string[] = []
  const scores: (number | null)[] = []
  const seen = new Set<string>()
  // Matches "=== DEFINITION path:1-2", "--- path:1-2 (...) [score: 0.87]", and reference lines "path:1-2  ..."
  const lineRe = /(?:^|\s)([\w.\\/-]+\.(?:py|ts|tsx|js|jsx|rs|go|java|c|cpp|rb|cs|lua|sh)):\d+/gm
  const scoreRe = /\[score: ([\d.]+)\]/
  for (const line of out.split('\n')) {
    const m = lineRe.exec(line)
    lineRe.lastIndex = 0
    if (!m) continue
    const canonical = m[1].replace(/\\/g, '/')
    if (seen.has(canonical)) continue
    seen.add(canonical)
    files.push(canonical)
    const s = scoreRe.exec(line)
    scores.push(line.startsWith('=== DEFINITION') ? 1.0 : s ? parseFloat(s[1]) : null)
    if (files.length >= topN) break
  }
  return { files, scores }
}

async function main() {
  if (!repoRoot || !query) {
    console.log(JSON.stringify({ skipped: 'usage: worker <repoRoot> <query> [topK]' }))
    return
  }
  let indexer: ProjectIndexer
  try {
    indexer = new ProjectIndexer(repoRoot)
  } catch (e) {
    console.log(JSON.stringify({ skipped: `open failed: ${e}` }))
    return
  }
  try {
    if (!indexer.hasEverIndexed()) {
      console.log(JSON.stringify({ skipped: 'no index' }))
      return
    }
    const anyIndexer = indexer as any
    if (typeof anyIndexer.searchFormatted === 'function') {
      // Match the real tool path (codeIndex.ts): freshness refresh, then search.
      if (typeof anyIndexer.refreshFromGitStatus === 'function') {
        try { await anyIndexer.refreshFromGitStatus() } catch (e) { console.error(`refresh failed: ${e}`) }
      }
      const out: string = await anyIndexer.searchFormatted({ query, topK })
      console.log(JSON.stringify(filesFromFormatted(out ?? '', topK)))
    } else {
      const results = await indexer.query({ query, topK })
      console.log(JSON.stringify({
        files: results.slice(0, topK).map(r => r.filePath),
        scores: results.slice(0, topK).map(r => r.score),
      }))
    }
  } catch (e) {
    console.log(JSON.stringify({ skipped: `query failed: ${e}` }))
  } finally {
    indexer.close()
  }
}

await main()
