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

/**
 * First line still in flight (status 'open', 'authoring' or 'proposed'), in
 * array order, or null.
 *
 * `proposed` counts (review #6): a proposed gate is not sealed, so it is not in
 * the heldout tree `mirrorPriorCampaigns` copies exemplars from. Authoring the
 * next line then would stage its `C<N>.9` prior-campaign line against a sibling
 * gate that is absent, and the check would refuse after a four-hour run. The
 * next line waits until this one is sealed — or rejected back to `authoring`.
 */
export function nextOpenLine(roadmap) {
  return roadmap.lines.find(l => l.status === 'open' || l.status === 'authoring' || l.status === 'proposed') ?? null
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

/**
 * The ONE backward move the ladder permits: `proposed` → `authoring`, when the
 * supervisor refuses a seal.
 *
 * Forward-only is right for everything else — a sealed gate does not un-seal, a
 * done campaign does not re-run — but a refused proposal has to reopen the line
 * it came from or the only route back is editing the JSON by hand. `--author`
 * refuses a `proposed` line (and `nextOpenLine` holds every later line behind
 * it), so without this a DO-NOT-SEAL verdict leaves the campaign stuck: the gate
 * cannot be re-authored, cannot be sealed, and blocks the rest of the roadmap.
 *
 * Deliberately its own function rather than a flag on `setLineStatus`: there is
 * exactly one legal backward transition, it is named here, and every other one
 * still throws.
 */
export function rejectLine(roadmap, id) {
  const line = lineFor(roadmap, id)
  if (!line) throw new Error(`rejectLine: unknown line id "${id}"`)
  if (line.status !== 'proposed') {
    throw new Error(`rejectLine: line "${id}" is "${line.status}" — only a "proposed" line can be rejected back to "authoring"`)
  }
  line.status = 'authoring'
  return roadmap
}

/** Writes the roadmap as 2-space JSON with a trailing LF. */
export function saveRoadmap(path, roadmap) {
  writeFileSync(path, JSON.stringify(roadmap, null, 2) + '\n')
}
