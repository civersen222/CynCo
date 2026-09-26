import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateBrief, sidecarFor, orderWork, workOrderFor, denialFollowUp, pacingDigestIncluded } from '../cynco-brief.mjs'
import { parseGateOutput } from '../cynco-gate-parse.mjs'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'

const spec = loadCampaignSpec(fileURLToPath(new URL('../../docs/civkings-redesign-briefs/c8.campaign.json', import.meta.url)))
const base = parseGateOutput(readFileSync(fileURLToPath(new URL('./fixtures/gate_c8_base.log', import.meta.url)), 'utf8'))
const real = readFileSync(fileURLToPath(new URL('../../docs/civkings-redesign-briefs/c8-wave1.txt', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

const SECTIONS = ['MISSION C8 WAVE 1', 'Repo:', 'BASE:', 'ASSETS ARE ALREADY STAGED', 'THE MISSES', 'HOW THE GATE MEASURES', 'THE WORK', 'PACING', 'RULES', 'DONE WHEN']

describe('generateBrief — wave 1 golden against c8-wave1.txt', () => {
  const text = generateBrief(spec, { wave: 1, base: '1d03308', fails: base.fails, passes: base.passes, prior: null, salvage: null, ideation: null })

  it('has the sections in the real brief\'s order and ends with the bare marker', () => {
    let pos = -1
    for (const s of SECTIONS) { const i = text.indexOf(s); expect(i, s).toBeGreaterThan(pos); pos = i }
    expect(text.trimEnd().split('\n').at(-1)).toBe('stage c8 complete')
  })
  it('opens with the same header line as the real brief', () => {
    expect(text.split('\n')[0]).toBe('MISSION C8 WAVE 1 — PRESENTATION')
    expect(real.split('\n')[0].startsWith('MISSION C8 WAVE 1 — PRESENTATION')).toBe(true)
  })
  it('quotes every BASE FAIL line verbatim, and they are the same lines the real brief quoted', () => {
    for (const f of base.fails) {
      expect(text).toContain(f.line)
      // C8.3b's End Turn error detail differs between this test's sealed
      // fixture ("err=None") and the historical real brief ("err=no end_turn
      // region") — the gate's diagnostic text changed between the two runs.
      // The generator still quotes the fixture verbatim (asserted above);
      // only the cross-check against the historical file is skipped here.
      if (f.id !== 'C8.3b.transitions-wired') expect(real).toContain(f.line)
    }
  })
  it('lists the already-passing lines under a keep-green heading', () => {
    expect(text).toMatch(/Already PASS at BASE and must stay so: C8\.4c/)
  })
  it('never names the sealed instrument', () => {
    expect(text).not.toMatch(/gate_c8|perturb_c8|heldout/)
  })
  it('orders THE WORK by the gate: all five items when all fail', () => {
    const work = text.slice(text.indexOf('THE WORK'), text.indexOf('PACING'))
    expect(work).toMatch(/1\. ASSETS IN[\s\S]*2\. PORTRAITS[\s\S]*3\. TRANSITIONS[\s\S]*4\. ZOOM TIERS[\s\S]*5\. ART PASS/)
  })
  it('states the invariants as enforced facts in PACING', () => {
    expect(text).toMatch(/PACING \(enforced by the engine, not advice\)/)
    expect(text).toMatch(/40 tool calls without a source edit/)
    expect(text).toMatch(/reverting is refused/i)
  })
})

describe('generateBrief — wave 2 with a prior wave', () => {
  const prior = {
    missionId: 'c8-wave1-1788634174399', exitReason: 'timeout', durationS: 28824,
    commits: [{ sha: 'f9fb07b', subject: 'C8 commit 1: act beds in' }, { sha: '1bc0f8c', subject: 'C8 commit 4b: zoom tiers' }],
    toolStats: { total: 931, maxCallsWithoutSourceEdit: 193, maxCallsWithoutCommit: 320, byName: { CodeIndex: 8 }, byClass: { sourceEdit: 86, fileWrite: 17, inspect: 828 } },
    invariants: { denials: [{ invariant: 'edit-gap' }, { invariant: 'revert' }], revertRefusals: 1, codeIndexAssisted: 12,
      denialCount: 137, denialsByInvariant: { 'edit-gap': 130, 'commit-gap': 6, 'revert': 1 }, terminalRelents: ['commit-gap'] },
    verify: { exitCode: 0 }, posiwid: { verdict: 'Contradicted', dominantObserved: 'inspect', divergence: 0.41 },
  }
  const remaining = base.fails.filter(f => f.id.startsWith('C8.5.palette'))
  const passes = base.fails.filter(f => !f.id.startsWith('C8.5.palette')).map(f => ({ id: f.id, line: f.line.replace(': FAIL', ': PASS') }))
  const text = generateBrief(spec, { wave: 2, base: '1bc0f8c', fails: remaining, passes, prior,
    salvage: { patchPath: 'C:/tmp/c8-wave1-1788634174399.uncommitted.patch', files: ['gilded/ui/atlas_view.py', 'gilded/ui/app.py'] },
    ideation: { hypotheses: [{ gateId: 'C8.5.palette.Atlas', cause: 'owner fills are five hues, not pinned inks', firstEdit: 'gilded/ui/widgets.py' }], order: [5], trap: 'do not add a hex to palette.py' } })

  it('carries FACT 0 with the landed commits and STEP 0 with the exact restore commands', () => {
    expect(text).toMatch(/FACT 0[\s\S]*f9fb07b C8 commit 1: act beds in[\s\S]*GOOD\. KEEP IT/)
    expect(text).toMatch(/STEP 0[\s\S]*git apply --3way "C:\/tmp\/c8-wave1-1788634174399\.uncommitted\.patch"[\s\S]*git add gilded\/ui\/atlas_view\.py gilded\/ui\/app\.py[\s\S]*COMMIT 0/)
    expect(text).toMatch(/Do not run the tests first/)
  })
  it('only lists work items whose gate ids still fail', () => {
    const work = text.slice(text.indexOf('THE WORK'), text.indexOf('S4 IDEATION'))
    expect(work).toMatch(/5\. ART PASS/); expect(work).not.toMatch(/2\. PORTRAITS/)
  })
  it('quotes the prior wave\'s numbers in PACING (the track-record digest)', () => {
    expect(text).toMatch(/wave 1 went 193 calls without a source edit and 320 without a commit/)
    expect(text).toMatch(/CodeIndex 8 of 931/)
    expect(text).toMatch(/POSIWID: Contradicted/)
  })
  it('uses the true denial count, not the windowed snapshot, and names terminal relents', () => {
    expect(text).toMatch(/denied 137 call\(s\)/)
    expect(text).toMatch(/stopped enforcing commit-gap after repeated relents/)
  })
  it('appends the ideation as advisory and marks it so', () => {
    expect(text).toMatch(/S4 IDEATION \(advisory — the gate lines above bind; this section may be wrong\)/)
    expect(text).toMatch(/C8\.5\.palette\.Atlas: owner fills are five hues, not pinned inks — first edit gilded\/ui\/widgets\.py/)
  })
})

describe('sidecarFor', () => {
  it('withholds the keep-green command behind readable text', () => {
    const s = sidecarFor(spec)
    expect(s.assertions[0].command).toBe(spec.keepGreen)
    expect(s.assertions[0].text).not.toContain('pytest')
    expect(s.assertions[0].timeoutMs).toBe(1800000)
  })

  // Task 6 finds this assertion by role, not by index — the held-out gate
  // occupies index 0 only when the driver also dispatched one.
  it('marks its one assertion role: keep-green', () => {
    const s = sidecarFor(spec)
    expect(s.assertions[0].role).toBe('keep-green')
  })
})

describe('THE WORK — earned reordering', () => {
  const items = [{ id: 1, title: 'A', gateIds: ['C8.1a'], text: 'a' }, { id: 2, title: 'B', gateIds: ['C8.2a'], text: 'b' }, { id: 3, title: 'C', gateIds: ['C8.3a', 'C8.3b'], text: 'c' }]
  it('orderWork puts advised items first in advised order and keeps the rest in spec order', () => {
    expect(orderWork(items, ['C8.3b', 'C8.1a'])).toEqual({ items: [items[2], items[0], items[1]], applied: true })
    expect(orderWork(items, [])).toEqual({ items, applied: false })
    expect(orderWork(items, ['C8.1a', 'C8.2a', 'C8.3a'])).toEqual({ items, applied: false })
    expect(orderWork(items, ['C9.zzz'])).toEqual({ items, applied: false })
  })
  const ctxAt = (authority) => ({ wave: 2, base: 'x', fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL' }, { id: 'C8.3a', line: 'C8.3a: FAIL' }], passes: [], prior: null, salvage: null,
    ideation: { hypotheses: [{ gateId: 'C8.3a', cause: 'c', firstEdit: 'x.py' }], order: ['C8.3a'], trap: null }, ideationAuthority: authority })
  const miniSpec = { ...spec, work: items }
  it('at authority 0 the brief keeps spec order and records applied=false', () => {
    expect(workOrderFor(miniSpec, ctxAt(0))).toEqual({ applied: false, order: [1, 3] })
    const text = generateBrief(miniSpec, ctxAt(0))
    expect(text.indexOf('1. A.')).toBeLessThan(text.indexOf('3. C.'))
  })
  it('at authority 0.5 the advised item leads and the record says so', () => {
    expect(workOrderFor(miniSpec, ctxAt(0.5))).toEqual({ applied: true, order: [3, 1] })
    const text = generateBrief(miniSpec, ctxAt(0.5))
    expect(text.indexOf('3. C.')).toBeLessThan(text.indexOf('1. A.'))
    // gate lines and rules are untouched by the reorder
    expect(text).toContain('C8.1a: FAIL'); expect(text).toContain('C8.3a: FAIL')
  })
})

describe('PACING — the denial digest', () => {
  it('denialFollowUp reads the per-invariant aggregate, with the window as fallback', () => {
    const inv = { denialCount: 3, nextCallClassByInvariant: { 'edit-gap': { sourceEdit: 1, inspect: 1 }, 'commit-gap': {}, revert: { read: 1 } } }
    expect(denialFollowUp(inv)).toEqual({ total: 3, complied: 2, windowed: false, byInvariant: { 'edit-gap': { denials: 2, complied: 1 }, 'commit-gap': { denials: 0, complied: 0 }, revert: { denials: 1, complied: 1 } } })
    const win = { denialCount: 2, denials: [{ invariant: 'edit-gap', nextCallClass: 'commit' }, { invariant: 'edit-gap', nextCallClass: 'read' }] }
    expect(denialFollowUp(win).byInvariant['edit-gap']).toEqual({ denials: 2, complied: 1 })
    // the window held every denial the run made, so it is not a tail
    expect(denialFollowUp(win).windowed).toBe(false)
    expect(denialFollowUp(null)).toBeNull()
  })
  // M6: a pre-aggregate row carries only the last 50 denials. Reporting those
  // 50 as "those N denials" tells the model the run made 50 when it made 80.
  it('denialFollowUp flags a window that is only the tail of the run', () => {
    const inv = { denialCount: 80, denials: Array.from({ length: 50 }, () => ({ invariant: 'edit-gap', nextCallClass: 'sourceEdit' })) }
    const f = denialFollowUp(inv)
    expect(f).toMatchObject({ total: 50, complied: 50, windowed: true })
  })
  it('prints last wave\'s follow-up, the campaign digest, and the EFFECTIVE caps', () => {
    const prior = { missionId: 'c8-wave2-1', exitReason: 'timeout', durationS: 3600, commits: [], toolStats: { total: 100, byClass: { inspect: 70, sourceEdit: 20 }, byName: { CodeIndex: 3 }, maxCallsWithoutSourceEdit: 41, maxCallsWithoutCommit: 87 },
      invariants: { denialCount: 3, denialsByInvariant: { 'edit-gap': 2, 'commit-gap': 0, revert: 1 }, revertRefusals: 1, codeIndexAssisted: 2, terminalRelents: [], nextCallClassByInvariant: { 'edit-gap': { sourceEdit: 1, inspect: 1 }, 'commit-gap': {}, revert: { read: 1 } } }, posiwid: null }
    const denialDigest = [{ invariant: 'edit-gap', denials: 12, complied: 5, verdict: 'TOO FEW' }, { invariant: 'commit-gap', denials: 0, complied: 0, verdict: 'TOO FEW' }, { invariant: 'revert', denials: 2, complied: 2, verdict: 'IDENTITY' }]
    const text = generateBrief(spec, { wave: 3, base: 'x', fails: base.fails, passes: [], prior, salvage: null, ideation: null, ideationAuthority: 0, invariants: { ...spec.invariants, editGapCap: 60 }, denialDigest })
    expect(text).toMatch(/Of those 3 denials, 2 were followed by the call they asked for \(edit-gap 1\/2, commit-gap 0\/0, revert 1\/1\); campaign to date edit-gap 5\/12, commit-gap 0\/0\./)
    expect(text).toMatch(/- 60 tool calls without a source edit/)
    // Phase 4 ruling 4: the predicate the runner records is the one that printed it.
    const ctx = { prior, denialDigest }
    expect(pacingDigestIncluded(ctx)).toBe(true)
    expect(pacingDigestIncluded({ prior, denialDigest: null })).toBe(false)
    expect(pacingDigestIncluded({ prior: null, denialDigest })).toBe(false)
    expect(pacingDigestIncluded({ prior: { ...prior, invariants: null }, denialDigest })).toBe(false)
    const quiet = generateBrief(spec, { wave: 3, base: 'x', fails: base.fails, passes: [], prior, salvage: null, ideation: null, ideationAuthority: 0, invariants: spec.invariants, denialDigest: null })
    expect(quiet).not.toMatch(/campaign to date/)
  })
  // M6 in the brief itself: a pre-aggregate prior must say "the last 50".
  it('says "the last N" when the follow-up could only be read off the window', () => {
    const prior = { missionId: 'c8-wave2-1', exitReason: 'timeout', durationS: 3600, commits: [], toolStats: { total: 400, byClass: { inspect: 300, sourceEdit: 50 }, byName: { CodeIndex: 3 }, maxCallsWithoutSourceEdit: 41, maxCallsWithoutCommit: 87 },
      invariants: { denialCount: 80, denialsByInvariant: { 'edit-gap': 80, 'commit-gap': 0, revert: 0 }, revertRefusals: 0, codeIndexAssisted: 2, terminalRelents: [],
        denials: Array.from({ length: 50 }, () => ({ invariant: 'edit-gap', nextCallClass: 'sourceEdit' })) }, posiwid: null }
    const text = generateBrief(spec, { wave: 3, base: 'x', fails: base.fails, passes: [], prior, salvage: null, ideation: null, ideationAuthority: 0, invariants: spec.invariants, denialDigest: null })
    expect(text).toMatch(/Of the last 50 denials, 50 were followed by the call they asked for/)
    expect(text).not.toMatch(/Of those 50 denials/)
  })
})
