import { execFile } from 'child_process'
import type { ToolImpl } from '../types.js'
import { ProjectIndexer } from '../../index/indexer.js'

const indexers = new Map<string, ProjectIndexer>()
// One build attempt per cwd per process — a repo that cannot index (no embed
// server, unreadable tree) must not pay the build cost on every query.
const buildAttempted = new Set<string>()

const SEARCH_GLOBS = '*.{py,ts,js,tsx,jsx,rs,go,java,c,cpp,rb}'
const MAX_HITS = 30

/**
 * Run a program with an argv array — never a command line. The query is
 * model-authored text, so it must never reach a shell as syntax; passing it as
 * one element of argv is what makes that structurally impossible rather than a
 * matter of escaping correctly.
 */
function run(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024, env: env ?? process.env },
      (err, stdout) => {
        // grep and rg exit 1 on "no matches", which is not an error worth logging.
        if (err && (err as { code?: number }).code !== 1) {
          console.log(`[CodeIndex] ${file} fallback unavailable: ${err.message.split('\n')[0]}`)
        }
        resolve(stdout ?? '')
      },
    )
  })
}

/** Fallback: regex search via ripgrep or PowerShell when vector index returns nothing. */
export async function regexFallback(query: string, cwd: string): Promise<string> {
  const rg = await run('rg', [
    '--no-heading', '--line-number', '--color', 'never',
    '--type-add', `code:${SEARCH_GLOBS}`, '-t', 'code',
    '-e', query, cwd,
  ], cwd)
  if (rg.trim()) return rg.trim().split('\n').slice(0, MAX_HITS).join('\n')

  if (process.platform === 'win32') {
    // PowerShell parses its own -Command string, so the query travels in the
    // environment instead of the script text and is never parsed as syntax.
    const script =
      `Get-ChildItem -Path $env:LOCALCODE_CI_CWD -Recurse -Include *.py,*.ts,*.js,*.tsx,*.jsx ` +
      `| Select-String -Pattern $env:LOCALCODE_CI_QUERY ` +
      `| Select-Object -First ${MAX_HITS} | ForEach-Object { $_.ToString() }`
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], cwd, {
      ...process.env,
      LOCALCODE_CI_QUERY: query,
      LOCALCODE_CI_CWD: cwd,
    })
    return ps.trim()
  }

  const grep = await run('grep', [
    '-rn', '--include=*.py', '--include=*.ts', '--include=*.js',
    '-e', query, cwd,
  ], cwd)
  return grep.trim().split('\n').slice(0, MAX_HITS).join('\n').trim()
}

export const codeIndexTool: ToolImpl = {
  name: 'CodeIndex',
  description: 'Search the codebase — tries semantic vector search first, falls back to regex pattern matching. Returns relevant functions, classes, and code blocks. Use this BEFORE Read to find the right files.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for — natural language ("combat system") or exact patterns ("def resolve_combat")' },
      top_k: { type: 'number', description: 'Number of results to return (default: 5, max: 20)' },
    },
    required: ['query'],
  },
  tier: 'auto',
  // Core: an extended tool costs a load_tools round trip before its first use,
  // and Grep costs none, so a two-call tax against a one-call alternative meant
  // this was never chosen even when it was the better question to ask.
  core: true,
  execute: async (input, cwd) => {
    const query = input.query as string
    const topK = Math.min(Math.max((input.top_k as number) ?? 5, 1), 20)

    // Try vector index first. Keyed by cwd — a single shared instance pointed
    // every project at whichever one happened to search first.
    let indexer = indexers.get(cwd)
    if (!indexer) {
      try {
        indexer = new ProjectIndexer(cwd)
        indexers.set(cwd, indexer)
      } catch (e) {
        console.log(`[CodeIndex] Could not open the index for ${cwd}: ${e}`)
      }
    }

    // Startup only auto-indexes the engine's own process.cwd(), so the first
    // query against any OTHER repo (a mission cwd) used to find an empty store
    // and silently degrade to regex for the whole run. Build it once, here.
    if (indexer && !buildAttempted.has(cwd)) {
      buildAttempted.add(cwd)
      try {
        if (!indexer.hasEverIndexed()) {
          console.log(`[CodeIndex] No index for ${cwd} — building it now`)
          const r = await indexer.index((m) => console.log(`[CodeIndex] ${m}`))
          console.log(`[CodeIndex] Built: ${r.chunks} chunks from ${r.files} files`)
        }
      } catch (e) {
        console.log(`[CodeIndex] First-use build failed for ${cwd} (non-fatal): ${e}`)
      }
    }

    if (indexer) {
      try {
        const output = await indexer.searchFormatted({ query, topK })
        if (output) {
          return { output, isError: false }
        }
      } catch (e) {
        console.log(`[CodeIndex] Query failed for "${query.slice(0, 40)}": ${e}`)
      }
    }

    // Symbol + semantic legs returned nothing — fall back to regex
    console.log(`[CodeIndex] Vector search empty for "${query.slice(0, 40)}" — falling back to regex`)
    const regexResults = await regexFallback(query, cwd)
    if (regexResults) {
      return { output: `[regex fallback]\n${regexResults}`, isError: false }
    }

    return { output: `No results for "${query}". Try a different search term, or run /analyze to rebuild the index.`, isError: false }
  },
}
