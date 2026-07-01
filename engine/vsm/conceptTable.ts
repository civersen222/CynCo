import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { buildConceptTable, type ConceptTable } from './groundingProbe.js'

const cache = new Map<string, ConceptTable>()
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build'])
const MAX_FILES = 2000
const MAX_BYTES = 2 * 1024 * 1024

/** Recursively collect .py file paths under root, skipping vendored/build dirs. */
function listPyFiles(root: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length && out.length < MAX_FILES) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(cur, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(full)
      } else if (name.endsWith('.py') && st.size <= MAX_BYTES) {
        out.push(full)
      }
    }
  }
  return out
}

/** Build (and cache) the concept-collision table for the given workspace. */
export function buildConceptTableForCwd(cwd: string): ConceptTable {
  const cached = cache.get(cwd)
  if (cached) return cached

  let table: ConceptTable
  try {
    const files = listPyFiles(cwd).map((path) => {
      let content = ''
      try {
        content = readFileSync(path, 'utf-8')
      } catch {
        /* unreadable file -> empty content */
      }
      return { path, content }
    })
    table = buildConceptTable(files)
  } catch {
    table = new Map()
  }
  cache.set(cwd, table)
  return table
}

/** Drop the cache (call when the workspace changes; used by tests). */
export function clearConceptTableCache(): void {
  cache.clear()
}
