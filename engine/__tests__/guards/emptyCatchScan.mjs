import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
export const engineRoot = join(here, '..', '..')

const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

export function currentCounts() {
  const counts = {}
  for (const file of walk(engineRoot)) {
    const n = (readFileSync(file, 'utf-8').match(EMPTY_CATCH) ?? []).length
    if (n > 0) counts[relative(engineRoot, file).replace(/\\/g, '/')] = n
  }
  return counts
}
