import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESIRED, complied, changed, denialRecords, buildTriples, exportTriples } from '../cynco-triples.mjs'

const row = (over = {}) => ({
  missionId: 'c8-wave2-1', outcome: 'landed', verified: true, exitReason: 'engine_closed_the_turn', durationS: 7200,
  commitRange: { base: 'aaa', head: 'bbb' },
  mutationSweep: { kind: 'derived', killed: 1, total: 2, survived: ['x.py:3'] },
  toolStats: { total: 100, commits: 4, byClass: { sourceEdit: 20, fileWrite: 3, inspect: 70 } },
  invariants: {
    caps: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    denialCount: 3, denialsByInvariant: { 'edit-gap': 2, 'commit-gap': 0, revert: 1 },
    denials: [
      { callIndex: 41, invariant: 'edit-gap', tool: 'Read', nextCallClass: 'sourceEdit' },
      { callIndex: 55, invariant: 'edit-gap', tool: 'Grep', nextCallClass: 'inspect' },
      { callIndex: 60, invariant: 'revert', tool: 'Bash', nextCallClass: 'read' },
    ],
    nextCallClassByInvariant: { 'edit-gap': { sourceEdit: 1, inspect: 1 }, 'commit-gap': {}, revert: { read: 1 } },
    nextCallClassCounts: { sourceEdit: 1, inspect: 1, read: 1 }, terminalRelents: [], revertRefusals: 1, codeIndexAssisted: 2,
  },
  posiwidLive: { verdict: 'Consistent' }, identityGuard: { passed: true, posiwidPass: true },
  ...over,
})

const campaign = (waves) => ({ id: 'c8', state: { calibration: { baseFails: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] } }, waves })
const wave = (over = {}) => ({
  wave: 2, missionId: 'c8-wave2-1', gate: { fails: [{ id: 'C', line: 'C: FAIL' }], passes: [] }, verified: true,
  sweep: { killed: 1, total: 2, survived: ['x.py:3'] }, sweepFault: null, posiwid: { verdict: 'Consistent', divergence: 0.01, dominantObserved: 'inspect' },
  outcome: { landed: true, exitReason: 'engine_closed_the_turn' },
  s4: { ideation: { hypotheses: [{ gateId: 'C', firstEdit: 'x.py' }], order: ['C'], trap: null }, authority: 0, commander: 'generator', followed: true, workOrder: { applied: false, order: [] } },
  decision: { kind: 'next', why: '1 line(s) still FAIL' }, ...over,
})

describe('complied / changed', () => {
  it('reads the desired next call per invariant', () => {
    expect(DESIRED['edit-gap']).toEqual(['sourceEdit', 'commit'])
    expect(complied('edit-gap', 'sourceEdit')).toBe(true)
    expect(complied('edit-gap', 'inspect')).toBe(false)
    expect(complied('commit-gap', 'commit')).toBe(true)
    expect(complied('commit-gap', 'sourceEdit')).toBe(false)
    expect(complied('revert', 'read')).toBe(true)
    expect(complied('revert', 'revert')).toBe(false)
    expect(complied('edit-gap', null)).toBe(false)
    expect(complied('edit-gap', 'pending')).toBe(false)
  })
  it('changed means the next call was not another look or another denial', () => {
    for (const c of ['inspect', 'read', 'codeIndex', 'denied-or-error', 'pending', null]) expect(changed(c)).toBe(false)
    for (const c of ['sourceEdit', 'commit', 'run', 'write', 'other']) expect(changed(c)).toBe(true)
  })
})

describe('denialRecords', () => {
  it('uses the window when it holds every denial', () => {
    const recs = denialRecords(row(), { campaign: 'c8', wave: 2 })
    expect(recs).toHaveLength(3)
    expect(recs[0]).toEqual({ kind: 'denial', campaign: 'c8', wave: 2, missionId: 'c8-wave2-1', invariant: 'edit-gap', tool: 'Read', callIndex: 41, nextCallClass: 'sourceEdit', count: 1, complied: true, changed: true, source: 'window' })
    expect(recs[2]).toMatchObject({ invariant: 'revert', complied: true, changed: false, source: 'window' })
  })
  it('falls back to the per-invariant aggregate when the window is truncated', () => {
    const r = row({ invariants: { ...row().invariants, denialCount: 80, nextCallClassByInvariant: { 'edit-gap': { sourceEdit: 30, inspect: 49 }, 'commit-gap': {}, revert: { read: 1 } } } })
    const recs = denialRecords(r, { campaign: 'c8', wave: 2 })
    expect(recs).toHaveLength(3)
    expect(recs.find(x => x.nextCallClass === 'sourceEdit')).toMatchObject({ source: 'aggregate', count: 30, complied: true, callIndex: null, tool: null })
    expect(recs.reduce((a, x) => a + x.count, 0)).toBe(80)
  })
  it('falls back to the window with truncation noted when a row predates the aggregate', () => {
    const inv = { ...row().invariants, denialCount: 80 }; delete inv.nextCallClassByInvariant
    const recs = denialRecords(row({ invariants: inv }), { campaign: 'c8', wave: 2 })
    expect(recs).toHaveLength(3)
    expect(recs[0].source).toBe('window')
  })
  it('yields nothing for a row without invariants', () => {
    expect(denialRecords(row({ invariants: null }), { campaign: null, wave: null })).toEqual([])
  })
})

describe('buildTriples', () => {
  it('joins wave records to ledger rows by missionId and emits all three kinds', () => {
    const faulted = { wave: 1, missionId: null, decision: { kind: 'fault', why: 'driver exited without a ledger row' } }
    const { records, summary } = buildTriples({ rows: [row()], campaigns: [campaign([faulted, wave()])] })
    const kinds = records.map(r => r.kind)
    expect(kinds.filter(k => k === 'denial')).toHaveLength(3)
    expect(kinds.filter(k => k === 'ideation')).toHaveLength(1)
    expect(kinds.filter(k => k === 'wave')).toHaveLength(2)
    const w = records.find(r => r.kind === 'wave' && r.wave === 2)
    expect(w).toMatchObject({ campaign: 'c8', missionId: 'c8-wave2-1', decision: 'next', failsBefore: ['A', 'B', 'C'], failsAfter: ['C'], linesFixed: 2, commits: 4, exitReason: 'engine_closed_the_turn', landed: true, verified: true, sweepFault: null })
    expect(w.hours).toBeCloseTo(2, 5)
    expect(w.invariants).toMatchObject({ denialCount: 3, revertRefusals: 1, codeIndexAssisted: 2, windowTruncated: false })
    expect(w.posiwidLive).toEqual({ verdict: 'Consistent' })
    expect(w.identityGuard).toEqual({ passed: true, posiwidPass: true })
    const f = records.find(r => r.kind === 'wave' && r.wave === 1)
    expect(f).toMatchObject({ campaign: 'c8', missionId: null, decision: 'fault', landed: null, verified: null, invariants: null })
    const i = records.find(r => r.kind === 'ideation')
    expect(i).toMatchObject({ campaign: 'c8', wave: 2, missionId: 'c8-wave2-1', authority: 0, commander: 'generator', hypotheses: 1, followed: true, landed: true, verified: true, decision: 'next', order: ['C'], workOrderApplied: false })
    expect(summary.counts).toEqual({ denial: 3, ideation: 1, wave: 2 })
    expect(summary.campaigns.c8).toEqual({ waves: 2, ideated: 1, followedLanded: { a: 1, b: 0, c: 0, d: 0 } })
    expect(summary.denials['edit-gap']).toEqual({ denials: 2, complied: 1, changed: 1 })
    expect(summary.denials.revert).toEqual({ denials: 1, complied: 1, changed: 0 })
    // quiet base-rate inputs (ruling 4): 100 − 3 = 97 quiet calls; edit-gap quiet compliance = 20 + 4 − 1
    expect(summary.quiet['edit-gap']).toEqual({ calls: 97, complied: 23 })
    expect(summary.quiet['commit-gap']).toEqual({ calls: 97, complied: 4 })
    expect(summary.quiet.revert).toEqual({ calls: 97, complied: 97 })
  })
  it('a row with invariants but no wave record still yields denial records with campaign null', () => {
    const { records } = buildTriples({ rows: [row({ missionId: 'hand-run-1' })], campaigns: [] })
    expect(records.filter(r => r.kind === 'denial').every(r => r.campaign === null && r.wave === null)).toBe(true)
    expect(records.filter(r => r.kind === 'wave')).toHaveLength(0)
  })
  it('failsBefore for a wave comes from the previous graded wave, not the faulted one between', () => {
    const w1 = wave({ wave: 1, missionId: 'c8-wave1-1', gate: { fails: [{ id: 'B' }, { id: 'C' }], passes: [] } })
    const fault = { wave: 2, missionId: null, decision: { kind: 'fault', why: 'x' } }
    const w3 = wave({ wave: 3, missionId: 'c8-wave3-1' })
    const { records } = buildTriples({ rows: [row({ missionId: 'c8-wave1-1' }), row({ missionId: 'c8-wave3-1' })], campaigns: [campaign([w1, fault, w3])] })
    const r3 = records.find(r => r.kind === 'wave' && r.wave === 3)
    expect(r3.failsBefore).toEqual(['B', 'C']); expect(r3.linesFixed).toBe(1)
  })
})

describe('exportTriples', () => {
  it('writes the dataset and the summary beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triples-'))
    const out = join(dir, 'triples.jsonl')
    const r = exportTriples({ rows: [row()], campaigns: [campaign([wave()])], outPath: out })
    expect(r.outPath).toBe(out)
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)).toEqual(['denial', 'denial', 'denial', 'ideation', 'wave'])
    expect(JSON.parse(readFileSync(join(dir, 'triples.summary.json'), 'utf8')).counts).toEqual({ denial: 3, ideation: 1, wave: 1 })
  })
})
