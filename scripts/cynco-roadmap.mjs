import { readFileSync, writeFileSync } from 'node:fs'

export const ROADMAP_PATH = 'docs/civkings-redesign-briefs/roadmap.json'
export const STATUSES = ['open', 'authoring', 'proposed', 'sealed', 'running', 'done']

const BASE_RE = /^[0-9a-f]{7,40}$/
const ID_RE = /^c\d+[a-z]?$/

/**
 * Loads and shape-validates the roadmap. Each shape error names its field
 * plainly, for the reason actually at fault — not because a stray word
 * happens to contain the field name.
 */
export function loadRoadmap(path = ROADMAP_PATH) {
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { throw new Error(`roadmap ${path}: invalid JSON (${e.message})`) }

  if (!parsed || !Array.isArray(parsed.lines)) {
    throw new Error(`roadmap ${path}: invalid shape — missing a "lines" array`)
  }

  parsed.lines.forEach((line, i) => {
    if (typeof line?.id !== 'string' || line.id.length === 0) {
      throw new Error(`roadmap ${path}: line ${i} missing id`)
    }
    if (!ID_RE.test(line.id)) {
      throw new Error(`roadmap ${path}: line has an invalid id "${line.id}" (expected c<number>[letter])`)
    }
    if (line.status === undefined) {
      throw new Error(`roadmap ${path}: line "${line.id}" missing status`)
    }
    if (!STATUSES.includes(line.status)) {
      throw new Error(`roadmap ${path}: line "${line.id}" has an unknown status "${line.status}" (must be one of ${STATUSES.join(', ')})`)
    }
    if (typeof line.bar !== 'string' || line.bar.length === 0) {
      throw new Error(`roadmap ${path}: line "${line.id}" missing bar`)
    }
    if (typeof line.base !== 'string' || !BASE_RE.test(line.base)) {
      throw new Error(`roadmap ${path}: line "${line.id}" has a bad base "${line.base}" (must match ${BASE_RE})`)
    }
  })

  return parsed
}

/** First line still in flight (status 'open' or 'authoring'), in array order, or null. */
export function nextOpenLine(roadmap) {
  return roadmap.lines.find(l => l.status === 'open' || l.status === 'authoring') ?? null
}

/** Looks up a line by id, or null if no line carries that id. */
export function lineFor(roadmap, id) {
  return roadmap.lines.find(l => l.id === id) ?? null
}

/**
 * Moves a line's status forward along STATUSES. Throws on an unknown id,
 * an unknown status, or a backward move (a lower index than the line's
 * current status) — the roadmap only ever advances.
 */
export function setLineStatus(roadmap, id, status) {
  const line = lineFor(roadmap, id)
  if (!line) throw new Error(`setLineStatus: unknown line id "${id}"`)

  const from = STATUSES.indexOf(line.status)
  const to = STATUSES.indexOf(status)
  if (to === -1) throw new Error(`setLineStatus: unknown status "${status}" (must be one of ${STATUSES.join(', ')})`)
  if (to < from) throw new Error(`setLineStatus: cannot move line "${id}" backward from "${line.status}" to "${status}"`)

  line.status = status
  return roadmap
}

/** Writes the roadmap as 2-space JSON with a trailing LF. */
export function saveRoadmap(path, roadmap) {
  writeFileSync(path, JSON.stringify(roadmap, null, 2) + '\n')
}
