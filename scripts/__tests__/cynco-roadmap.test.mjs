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

  it('nextOpenLine on the checked-in roadmap is c9', () => {
    const roadmap = loadRoadmap()
    const next = nextOpenLine(roadmap)
    expect(next).not.toBeNull()
    expect(next.id).toBe('c9')
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
  it('allows a forward move: open -> authoring', () => {
    const roadmap = loadRoadmap()
    setLineStatus(roadmap, 'c9', 'authoring')
    expect(lineFor(roadmap, 'c9').status).toBe('authoring')
  })

  it('throws /backward/ on authoring -> open', () => {
    const roadmap = loadRoadmap()
    setLineStatus(roadmap, 'c9', 'authoring')
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
  it('throws /id/ on a line missing status/bar/base ({ id: "x9" })', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'x9' }] }))
    expect(() => loadRoadmap(p)).toThrow(/id/)
  })

  it('throws /status/ on a line with an invalid status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'x9', status: 'nope', bar: 'b', base: '1234567' }] }))
    expect(() => loadRoadmap(p)).toThrow(/status/)
  })

  it('throws /bar/ on a line missing bar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'x9', status: 'open', base: '1234567' }] }))
    expect(() => loadRoadmap(p)).toThrow(/bar/)
  })

  it('throws /base/ on a line with an invalid base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    writeFileSync(p, JSON.stringify({ lines: [{ id: 'x9', status: 'open', bar: 'b', base: 'zzz' }] }))
    expect(() => loadRoadmap(p)).toThrow(/base/)
  })
})

describe('saveRoadmap', () => {
  it('round-trips with LF line endings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    const p = join(dir, 'roadmap.json')
    const roadmap = { lines: [{ id: 'z1', name: 'Z', bar: 'zbar', base: '1234567', status: 'open' }] }
    saveRoadmap(p, roadmap)
    const raw = readFileSync(p, 'utf8')
    expect(raw.includes('\r')).toBe(false)
    expect(raw.endsWith('\n')).toBe(true)
    const reloaded = loadRoadmap(p)
    expect(reloaded).toEqual(roadmap)
  })
})
