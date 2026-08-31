import { existsSync, readdirSync } from 'fs'
import { dirname, basename } from 'path'

/**
 * Finding from C6 wave 4 (mission c6-wave4-1788187167100, F136).
 *
 * The model asked for gilded/ui/broadcast.py — a file that has never existed;
 * the real file is broadsheet.py, one edit apart. "Error: file not found" told
 * it nothing it could steer by, so it retried the same phantom path 7 times
 * across Read, Grep and Bash until the 5-consecutive-failure halt killed the
 * run at 32 turns with zero commits. The error message was the fixation.
 *
 * A denial must teach (close-the-loop directive): when the file is missing,
 * say what IS there — the nearest-named sibling and the directory listing.
 * With that, the wave-4 loop breaks at error 1 instead of halt at error 5.
 */

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]
}

const MAX_LISTED = 15

/**
 * Build the error message for a path that does not exist. Includes the
 * contents of the nearest existing ancestor directory and, when a sibling
 * name is close to the requested one, a direct "did you mean" pointer.
 */
export function missingFileHint(filePath: string): string {
  const base = `Error: file not found: ${filePath}`

  // Walk up to the nearest directory that actually exists.
  let dir = dirname(filePath)
  const missingAncestors: string[] = []
  while (dir !== dirname(dir) && !existsSync(dir)) {
    missingAncestors.push(dir)
    dir = dirname(dir)
  }
  if (!existsSync(dir)) return base

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return base
  }

  const lines = [base]
  if (missingAncestors.length > 0) {
    lines.push(`The directory ${missingAncestors[missingAncestors.length - 1]} does not exist either; the nearest existing directory is ${dir}.`)
  }

  const wanted = basename(filePath).toLowerCase()
  let best: string | null = null
  let bestDist = Infinity
  for (const e of entries) {
    const d = levenshtein(wanted, e.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = e
    }
  }
  // Close enough to be a slip of the same name, not a different file.
  if (best !== null && bestDist <= Math.max(2, Math.floor(wanted.length / 3))) {
    lines.push(`Did you mean: ${best}?`)
  }

  const listed = entries.slice(0, MAX_LISTED).join(', ')
  const more = entries.length > MAX_LISTED ? ` (+${entries.length - MAX_LISTED} more)` : ''
  lines.push(entries.length === 0 ? `${dir} is empty.` : `${dir} contains: ${listed}${more}`)
  lines.push('Do not retry this path — it does not exist. Pick a listed file or search with Glob.')
  return lines.join('\n')
}
