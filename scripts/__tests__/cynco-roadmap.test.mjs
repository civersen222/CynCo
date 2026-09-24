import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROADMAP_PATH, STATUSES,
  loadRoadmap, nextOpenLine, setLineStatus, saveRoadmap, lineFor,
} from '../cynco-roadmap.mjs'

describe('cynco-roadmap: checked-in roadmap.json', () => {
  it('loads the checked-in roadmap with 4 lines', () => {
    const roadmap = loadRoadmap()
    expect(roadmap.lines).toHaveLength(4)
    expect(roadmap.lines.map(l => l.id)).toEqual(['c6', 'c7', 'c8', 'c9'])
  })

  // The checked-in file's STATUSES move as the campaign ladder advances — c9 went
  // open → authoring → proposed during Phase 3's live runs — so the invariant to
  // assert here is the ORDER (`nextOpenLine` answers the earliest line still in
  // flight, or null once none is), never one particular line's current value.
  // `setLineStatus`'s own behaviour is tested against fixtures below, for the same
  // reason: a test pinned to live data fails on the day the data is correct.
  it('nextOpenLine answers the earliest line still open or authoring, or null', () => {
    const roadmap = loadRoadmap()
    const next = nextOpenLine(roadmap)
    // Its own predicate: a `proposed` line is past authoring and is NOT in flight
    // for this purpose — that is what lets `--author` refuse it until a rejection
    // moves it back.
    const inFlight = roadmap.lines.filter(l => l.status === 'open' || l.status === 'authoring')
    if (inFlight.length === 0) expect(next).toBeNull()
    else expect(next.id).toBe(inFlight[0].id)
  })

  it('ROADMAP_PATH points at the checked-in file', () => {
    expect(ROADMAP_PATH).toBe('docs/civkings-redesign-briefs/roadmap.json')
  })

  it('lineFor finds a line by id and returns null for an unknown id', () => {
    const roadmap = loadRoadmap()
    expect(lineFor(roadmap, 'c7').name).toBe('Content depth')
    expect(lineFor(roadmap, 'nope')).toBeNull()
  })
})

describe('setLineStatus', () => {
  // A fixture, not the checked-in file: the ladder's job is to move, so a test of
  // the LADDER cannot depend on where the live roadmap happens to stand today.
  const FIXTURE = (status = 'open') => ({ lines: [{ id: 'c9', name: 'Ship shell', bar: 'b', base: 'abcdef1', status }] })

  it('allows a forward move: open -> authoring', () => {
    const roadmap = FIXTURE()
    setLineStatus(roadmap, 'c9', 'authoring')
    expect(lineFor(roadmap, 'c9').status).toBe('authoring')
  })

  it('throws /backward/ on authoring -> open', () => {
    const roadmap = FIXTURE('authoring')
    expect(() => setLineStatus(roadmap, 'c9', 'open')).toThrow(/backward/)
  })

  it('throws /unknown/ on an unknown status', () => {
    const roadmap = loadRoadmap()
    expect(() => setLineStatus(roadmap, 'c9', 'not-a-status')).toThrow(/unknown/)
  })

  it('throws /unknown/ on an unknown id', () => {
    const roadmap = loadRoadmap()
    expect(() => setLineStatus(roadmap, 'nope', 'authoring')).toThrow(/unknown/)
  })

  it('STATUSES carries the full monotone sequence', () => {
    expect(STATUSES).toEqual(['open', 'authoring', 'proposed', 'sealed', 'running', 'done'])
  })
})

describe('loadRoadmap shape validation', () => {
  it('throws on an id that does not match c<number>[letter], even with every other field valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'x9', name: 'n', bar: 'b', base: 'abcdef1', status: 'open' }] }))
    expect(() => loadRoadmap(p)).toThrow(/invalid id/)
  })

  it('accepts a trailing-letter id like c6b', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'c6b', name: 'n', bar: 'b', base: 'abcdef1', status: 'open' }] }))
    expect(loadRoadmap(p).lines[0].id).toBe('c6b')
  })

  it('throws /missing status/ on a valid id with no status field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'c9', name: 'n', bar: 'b', base: 'abcdef1' }] }))
    expect(() => loadRoadmap(p)).toThrow(/missing status/)
  })

  it('throws /unknown status/ on a valid id with an out-of-enum status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'c9', status: 'nope', bar: 'b', base: '1234567' }] }))
    expect(() => loadRoadmap(p)).toThrow(/unknown status/)
  })

  it('throws /missing bar/ on a line missing bar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'c9', status: 'open', base: '1234567' }] }))
    expect(() => loadRoadmap(p)).toThrow(/missing bar/)
  })

  it('throws /bad base/ on a line with an invalid base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'c9', status: 'open', bar: 'b', base: 'zzz' }] }))
    expect(() => loadRoadmap(p)).toThrow(/bad base/)
  })
})

describe('saveRoadmap', () => {
  it('round-trips with LF line endings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    const roadmap = { lines: [{ id: 'c1', name: 'Z', bar: 'zbar', base: '1234567', status: 'open' }] }
    saveRoadmap(p, roadmap)
    const raw = readFileSync(p, 'utf8')
    expect(raw.includes('\r')).toBe(false)
    expect(raw.endsWith('\n')).toBe(true)
    const reloaded = loadRoadmap(p)
    expect(reloaded).toEqual(roadmap)
  })
})
