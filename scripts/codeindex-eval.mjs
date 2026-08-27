/**
 * CodeIndex eval harness — replays real retrieval queries from mission
 * trajectories against (a) Grep as originally invoked and (b) the CodeIndex
 * pipeline, scoring gold-file-in-top-3.
 *
 * Usage: node scripts/codeindex-eval.mjs [--label before|after] [--limit N]
 *
 * Gold label per Grep query: files present in its result that the model then
 * Read/Edit/ReplaceFunction'd within the next 5 tool calls of the same
 * trajectory. Queries with no gold are excluded (reported as coverage).
 * File-scoped Greps (path = a single file) are verification, not retrieval —
 * excluded from scoring, counted separately.
 *
 * CodeIndex replay goes through scripts/codeindex-eval-worker.ts (bun) so the
 * engine's bun:sqlite pipeline runs in its native runtime. The worker never
 * full-builds a missing index — repos without one are skipped.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { join, dirname, extname, resolve } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TRAJ_DIR = join(homedir(), '.cynco', 'trajectories')
const argAfter = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const LABEL = argAfter('--label', 'before')
const LIMIT = parseInt(argAfter('--limit', '60'), 10)
const TOPK = 3

const SOURCE_EXTS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.rb', '.cs', '.lua', '.sh'])
const STOPWORDS = new Set(['the', 'and', 'for', 'def', 'class', 'function', 'body', 'where', 'what', 'how',
  'find', 'show', 'get', 'all', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'into', 'used', 'use',
  'code', 'file', 'files', 'line', 'lines', 'method', 'implementation', 'definition', 'of', 'in', 'is', 'a', 'an', 'to'])

const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase()

/** Symbol-class if any token looks like an identifier (underscore/camelCase/dunder). */
function isSymbolClass(query) {
  const tokens = String(query).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  return tokens.some(t => t.includes('_') || /[a-z][A-Z]/.test(t))
}

/** Walk up from a path to the enclosing git repo root, or null. */
function repoRootOf(p) {
  let dir = p
  try { if (!statSync(dir).isDirectory()) dir = dirname(dir) } catch { return null }
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// ─── 1. EXTRACT ────────────────────────────────────────────────────────────
function loadTrajectories() {
  const files = readdirSync(TRAJ_DIR).filter(f => f.endsWith('.messages.json'))
    .map(f => ({ f, m: statSync(join(TRAJ_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m).slice(0, LIMIT)
  const trajs = []
  for (const { f } of files) {
    try {
      const d = JSON.parse(readFileSync(join(TRAJ_DIR, f), 'utf-8'))
      if (!Array.isArray(d.messages)) continue
      // Ordered tool call sequence with paired results.
      const calls = []
      const byId = new Map()
      for (const m of d.messages) {
        const content = m && m.content
        if (!Array.isArray(content)) continue
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'tool_use') {
            const call = { name: b.name, input: b.input ?? {}, result: '' }
            byId.set(b.id, call)
            calls.push(call)
          } else if (b.type === 'tool_result' && byId.has(b.tool_use_id)) {
            const c = b.content
            byId.get(b.tool_use_id).result = typeof c === 'string' ? c
              : Array.isArray(c) ? c.map(x => x?.text ?? '').join('\n') : ''
          }
        }
      }
      trajs.push({ file: f, calls })
    } catch { /* unreadable trajectory — skip */ }
  }
  return trajs
}

// ─── 2. GOLD ───────────────────────────────────────────────────────────────
function resultFiles(call) {
  const p = call.input.path ?? call.input.file_path ?? ''
  const isFile = p && SOURCE_EXTS.has(extname(p).toLowerCase())
  if (isFile) return { scoped: 'file', files: [p] }
  const files = new Set()
  for (const line of call.result.split('\n')) {
    const m = line.match(/^(.+?\.[A-Za-z]{1,4}):\d+[:-]/)
    if (m) files.add(/^[A-Za-z]:[\\/]/.test(m[1]) ? m[1] : join(p || '.', m[1]))
  }
  return { scoped: 'dir', files: [...files] }
}

function extractCases(trajs) {
  const grepCases = []
  const codeIndexCalls = []
  let fileScoped = 0
  for (const t of trajs) {
    t.calls.forEach((call, i) => {
      if (call.name === 'CodeIndex' && call.input.query) {
        codeIndexCalls.push({ traj: t.file, query: call.input.query, seq: i, calls: t.calls })
      }
      if (call.name !== 'Grep' || !call.input.pattern) return
      const { scoped, files } = resultFiles(call)
      if (scoped === 'file') { fileScoped++; return }
      if (files.length === 0) return
      const upcoming = t.calls.slice(i + 1, i + 6)
        .filter(c => ['Read', 'Edit', 'ReplaceFunction', 'Write', 'MultiEdit'].includes(c.name))
        .map(c => norm(c.input.file_path ?? ''))
      const gold = files.filter(f => upcoming.some(u => u && (u === norm(f) || u.endsWith(norm(f)) || norm(f).endsWith(u))))
      const root = repoRootOf(call.input.path ?? files[0])
      grepCases.push({ traj: t.file, pattern: call.input.pattern, path: call.input.path ?? root, root, gold })
    })
  }
  return { grepCases, codeIndexCalls, fileScoped }
}

// gold for a CodeIndex call: same next-5 heuristic, but against Read/Edit targets only
function codeIndexGold(c) {
  const upcoming = c.calls.slice(c.seq + 1, c.seq + 6)
    .filter(x => ['Read', 'Edit', 'ReplaceFunction'].includes(x.name))
    .map(x => x.input.file_path).filter(Boolean)
  return upcoming
}

// ─── 3. REPLAY ─────────────────────────────────────────────────────────────
function replayGrep(pattern, path) {
  try {
    const out = execFileSync('rg', ['--files-with-matches', '--color', 'never', '-e', pattern, path],
      { encoding: 'utf-8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter(Boolean).slice(0, TOPK)
  } catch (e) {
    if (e.status === 1) return []          // no matches
    return null                            // rg unavailable/errored — exclude
  }
}

function replayCodeIndex(root, query) {
  try {
    const out = execFileSync('bun', ['run', join(ROOT, 'scripts', 'codeindex-eval-worker.ts'), root, query, String(TOPK)],
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    const lastLine = out.trim().split('\n').pop()
    return JSON.parse(lastLine)
  } catch {
    return { skipped: 'worker failed' }
  }
}

const hit = (files, gold, root) => gold.some(g =>
  (files ?? []).some(f => {
    const nf = norm(f); const ng = norm(g)
    const abs = /^[a-z]:[\\/]/.test(nf) ? nf : norm(join(root ?? '', f))
    return abs === ng || ng.endsWith(nf) || abs.endsWith(ng)
  }))

// ─── 4. RUN + REPORT ───────────────────────────────────────────────────────
const trajs = loadTrajectories()
const { grepCases, codeIndexCalls, fileScoped } = extractCases(trajs)
const scorable = grepCases.filter(c => c.gold.length > 0 && c.root && existsSync(c.root))

const stats = {
  symbol: { n: 0, grep: 0, ci: 0 }, conceptual: { n: 0, grep: 0, ci: 0 },
  skippedRepos: new Set(), ciSkipped: 0,
}
const scoreDump = []
const perQuery = []
for (const c of scorable) {
  const cls = isSymbolClass(c.pattern) ? 'symbol' : 'conceptual'
  const grepFiles = replayGrep(c.pattern, c.path)
  const ci = replayCodeIndex(c.root, c.pattern)
  if (ci.skipped) { stats.ciSkipped++; stats.skippedRepos.add(`${c.root} (${ci.skipped})`); continue }
  stats[cls].n++
  const g = grepFiles !== null && hit(grepFiles, c.gold, c.root)
  const x = hit(ci.files, c.gold, c.root)
  if (g) stats[cls].grep++
  if (x) stats[cls].ci++
  scoreDump.push({ cls, hit: x, topScore: ci.scores?.[0] ?? null })
  perQuery.push({ cls, pattern: c.pattern.slice(0, 80), gold: c.gold.map(norm), grep: g, ci: x, ciTop: (ci.files ?? [])[0] ?? '' })
}

// Burned CodeIndex queries, verbatim
const burned = []
for (const c of codeIndexCalls) {
  const root = repoRootOf(c.calls.find(x => x.input?.path || x.input?.file_path)?.input?.path
    ?? c.calls.find(x => x.input?.file_path)?.input?.file_path ?? '')
  const gold = codeIndexGold(c)
  const replay = root && existsSync(root) ? replayCodeIndex(root, c.query) : { skipped: 'repo missing' }
  burned.push({ query: c.query, root, gold, top1: replay.files?.[0] ?? `(${replay.skipped ?? 'none'})`, hitTop1: gold.length > 0 && hit((replay.files ?? []).slice(0, 1), gold, root) })
}

const pct = (a, b) => b === 0 ? '—' : `${(100 * a / b).toFixed(0)}% (${a}/${b})`
const date = new Date().toISOString().slice(0, 10)
const outDir = join(ROOT, 'benchmark', 'codeindex-eval')
mkdirSync(outDir, { recursive: true })
const report = `# CodeIndex eval — ${LABEL} (${date})

Trajectories: ${trajs.length} · Grep calls dir-scoped with gold: ${scorable.length} of ${grepCases.length} (coverage ${pct(scorable.length, grepCases.length)}) · file-scoped (verification, excluded): ${fileScoped} · CodeIndex replays skipped: ${stats.ciSkipped}
${stats.skippedRepos.size ? 'Skipped repos: ' + [...stats.skippedRepos].join('; ') : ''}

## Top-3 file hit rate

| class | n | Grep | CodeIndex |
|---|---|---|---|
| symbol | ${stats.symbol.n} | ${pct(stats.symbol.grep, stats.symbol.n)} | ${pct(stats.symbol.ci, stats.symbol.n)} |
| conceptual | ${stats.conceptual.n} | ${pct(stats.conceptual.grep, stats.conceptual.n)} | ${pct(stats.conceptual.ci, stats.conceptual.n)} |

## Burned CodeIndex queries (verbatim replay)

| query | top-1 | gold hit top-1 |
|---|---|---|
${burned.map(b => `| ${b.query.slice(0, 60).replace(/\|/g, '\\|')} | ${String(b.top1).replace(/\|/g, '\\|')} | ${b.gold.length === 0 ? 'no gold' : b.hitTop1 ? 'YES' : 'no'} |`).join('\n')}

## Score dump (floor calibration)

hits:   ${scoreDump.filter(s => s.hit).map(s => s.topScore).filter(s => s != null).map(s => s.toFixed(2)).join(', ') || '—'}
misses: ${scoreDump.filter(s => !s.hit).map(s => s.topScore).filter(s => s != null).map(s => s.toFixed(2)).join(', ') || '—'}

## Per-query detail

| class | pattern | grep | ci | ci top-1 |
|---|---|---|---|---|
${perQuery.map(q => `| ${q.cls} | \`${q.pattern.replace(/\|/g, '\\|')}\` | ${q.grep ? 'HIT' : 'miss'} | ${q.ci ? 'HIT' : 'miss'} | ${String(q.ciTop).replace(/\|/g, '\\|')} |`).join('\n')}
`
const outPath = join(outDir, `results-${date}-${LABEL}.md`)
writeFileSync(outPath, report)
console.log(report.split('\n').slice(0, 20).join('\n'))
console.log(`\nWritten: ${outPath}`)
