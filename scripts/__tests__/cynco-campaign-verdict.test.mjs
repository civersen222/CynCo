import { describe, it, expect } from 'vitest'
import { verdictEntry, notify, commitVerdict } from '../cynco-campaign-verdict.mjs'

const grade = { sha: '1bc0f8c', verified: false,
  gate: { fails: [{ id: 'C8.5.palette.Atlas', line: 'C8.5.palette.Atlas: FAIL pixels within 24/channel of a pinned ink at t40 = 0.71 (floor 0.9)' }], passes: [{ id: 'C8.1a', line: 'C8.1a: PASS' }], terminator: 'MISS', failCount: 1, priorRegressions: 0, exit: 1, durationMs: 120000, harnessFault: null },
  suite: { exit: 0, regressions: [], repairs: ['gilded/tests/a.py::t'], harnessFault: null },
  sweep: { kind: 'derived', killed: 6, total: 25, survived: ['gilded/ui/x.py:3'] },
  posiwid: { verdict: 'Drifting', divergence: 0.21, dominantObserved: 'inspect', dominantStated: 'inspect', support: 931 } }
const row = { missionId: 'c8-wave1-1788634174399', exitReason: 'timeout', durationS: 28824, commitRange: { base: '1d03308', head: '1bc0f8c' },
  toolStats: { total: 931, commits: 5, maxCallsWithoutSourceEdit: 193, maxCallsWithoutCommit: 320, byName: { CodeIndex: 8 } }, graderProbes: { probes: 1, total: 931 },
  invariants: { denials: [{ invariant: 'edit-gap' }], denialCount: 1, denialsByInvariant: { 'edit-gap': 1 }, revertRefusals: 1, codeIndexAssisted: 3 } }

describe('verdictEntry', () => {
  const text = verdictEntry({ spec: { id: 'c8' }, wave: 1, row, grade, decision: { kind: 'next', why: '1 line(s) still FAIL' }, ideationRecord: null, economicsLines: ['VERDICT: frontier spent $1.00 SUPERVISING'] })
  it('uses the campaign-log heading and quotes the FAIL line verbatim', () => {
    expect(text.split('\n')[0]).toMatch(/^## C8 wave 1 — c8-wave1-1788634174399 \(graded \d{4}-\d{2}-\d{2}, BASE 1d03308 → HEAD 1bc0f8c\)$/)
    expect(text).toContain('C8.5.palette.Atlas: FAIL pixels within 24/channel of a pinned ink at t40 = 0.71 (floor 0.9)')
  })
  it('reports pacing, invariants, sweep, POSIWID, suite and economics', () => {
    expect(text).toMatch(/931 tool calls.*timeout.*28824/s)
    expect(text).toMatch(/maxCallsWithoutSourceEdit 193/)
    expect(text).toMatch(/engine denied 1 call\(s\) \(edit-gap 1\), 1 revert refusal\(s\), 3 CodeIndex-assisted/)
    expect(text).toMatch(/Derived sweep 6\/25.*gilded\/ui\/x\.py:3/)
    expect(text).toMatch(/POSIWID Drifting \(divergence 0\.210, dominant inspect\)/)
    expect(text).toMatch(/Suite gate PASS.*REPAIRED 1/)
    expect(text).toMatch(/VERDICT: frontier spent/)
    expect(text).toMatch(/^Verdict: \*\*MISS\*\* — 1 line\(s\) still FAIL/m)
  })
  it('names terminal relents when the engine stopped enforcing an invariant', () => {
    const relentRow = { ...row, invariants: { ...row.invariants, terminalRelents: ['commit-gap'] } }
    const relentText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row: relentRow, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(relentText).toMatch(/The engine stopped enforcing commit-gap after repeated relents\./)
  })
  it('reports the Bash-by-effect classifier/regulator agreement check', () => {
    const beRow = { ...row, toolStats: { ...row.toolStats, bashByEffect: { read: 200, write: 20, run: 30, commit: 5, revert: 0, other: 10 }, byName: { CodeIndex: 8, Bash: 265 } } }
    const beText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row: beRow, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(beText).toMatch(/Bash by effect: read 200, write 20, run 30, commit 5, revert 0, other 10 \(sum 265 vs byName\.Bash 265 — agree\)\./)
  })
  it('reports DISAGREE when the effect sum does not match byName.Bash', () => {
    const beRow = { ...row, toolStats: { ...row.toolStats, bashByEffect: { read: 200, write: 20, run: 30, commit: 5, revert: 0, other: 10 }, byName: { CodeIndex: 8, Bash: 999 } } }
    const beText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row: beRow, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(beText).toMatch(/sum 265 vs byName\.Bash 999 — DISAGREE/)
  })
  it('names the sweep fault instead of the generic UNMEASURED line', () => {
    const faultGrade = { ...grade, sweep: null, sweepFault: 'timed out after 3600000 ms' }
    const faultText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row, grade: faultGrade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(faultText).toMatch(/- Derived sweep: UNMEASURED — timed out after 3600000 ms\./)
    expect(faultText).not.toMatch(/no diff or the sweep refused/)
  })
  it('keeps the generic UNMEASURED line when there was simply no diff', () => {
    const noDiffGrade = { ...grade, sweep: null, sweepFault: null }
    const noDiffText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row, grade: noDiffGrade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(noDiffText).toMatch(/- Derived sweep: UNMEASURED \(no diff or the sweep refused\)\./)
  })
  it('renders INVARIANTS REJECTED loudly and forces STOP (fault) regardless of decision.kind', () => {
    const rejectedRow = { ...row, invariantsRejected: true }
    const rejectedText = verdictEntry({ spec: { id: 'c8' }, wave: 1, row: rejectedRow, grade, decision: { kind: 'next', why: 'invariants were rejected' }, ideationRecord: null, economicsLines: [] })
    expect(rejectedText).toMatch(/\*\*INVARIANTS REJECTED — the wave ran without its orders\.\*\*/)
    expect(rejectedText).toMatch(/^Verdict: \*\*STOP \(fault\)\*\* — invariants were rejected/m)
  })
})

describe('notify', () => {
  it('returns false without a URL and posts the ntfy shape with one', async () => {
    expect(await notify('x', {})).toBe(false)
    const seen = []
    const ok = await notify('hello', { CYNCO_NTFY_URL: 'http://n', CYNCO_NTFY_TOKEN: 'tk' }, async (url, init) => { seen.push({ url, init }); return { ok: true } })
    expect(ok).toBe(true)
    expect(seen[0].url).toBe('http://n/')
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ topic: 'cynco-alerts', message: 'hello' })
    expect(seen[0].init.headers.Authorization).toBe('Bearer tk')
  })
})

describe('commitVerdict', () => {
  it('creates the branch once, stages by name, refuses a dirty tree', () => {
    const calls = []
    const io = { git: (args) => { calls.push(args.join(' ')); if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 1, stdout: '' }; if (args[0] === 'status') return { status: 0, stdout: ' M docs/x.md\n' }; if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { status: 0, stdout: 'campaign/c8\n' }; if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc123\n' }; return { status: 0, stdout: '' } } }
    const r = commitVerdict({ repoRoot: '.', branch: 'campaign/c8', files: ['docs/x.md'], message: 'm', io })
    expect(calls).toContain('checkout -b campaign/c8')
    expect(calls).toContain('add docs/x.md')
    expect(r.sha).toBe('abc123')
    const dirty = { git: (args) => args[0] === 'status' ? { status: 0, stdout: ' M engine/other.ts\n M docs/x.md\n' } : { status: 0, stdout: '' } }
    expect(() => commitVerdict({ repoRoot: '.', branch: 'campaign/c8', files: ['docs/x.md'], message: 'm', io: dirty })).toThrow(/engine\/other\.ts/)
  })

  // A failed checkout used to be silent: add + commit ran anyway and the verdict
  // landed on whatever branch the tree was on — main, most likely.
  it('throws instead of committing when the checkout fails', () => {
    const calls = []
    const io = { git: (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'status') return { status: 0, stdout: '' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, stdout: 'abc\n' }
      if (args[0] === 'checkout') return { status: 1, stdout: '', stderr: 'error: Your local changes would be overwritten\n' }
      return { status: 0, stdout: 'main\n' }
    } }
    expect(() => commitVerdict({ repoRoot: '.', branch: 'campaign/c8', files: ['docs/x.md'], message: 'm', io }))
      .toThrow(/commitVerdict: git checkout campaign\/c8 failed: error: Your local changes would be overwritten/)
    expect(calls.some(c => c.startsWith('add '))).toBe(false)
    expect(calls.some(c => c.startsWith('commit '))).toBe(false)
  })

  // A checkout that reports success but leaves HEAD elsewhere (a detached HEAD,
  // a hook) is the same failure wearing a 0 exit code.
  it('throws when HEAD is not the branch after a successful checkout', () => {
    const calls = []
    const io = { git: (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'status') return { status: 0, stdout: '' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, stdout: 'abc\n' }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { status: 0, stdout: 'main\n' }
      return { status: 0, stdout: '' }
    } }
    expect(() => commitVerdict({ repoRoot: '.', branch: 'campaign/c8', files: ['docs/x.md'], message: 'm', io })).toThrow(/HEAD is main/)
    expect(calls.some(c => c.startsWith('add '))).toBe(false)
  })
})

// C1: a green gate with survivors only in files the campaign never claimed is
// still a campaign PASS — the label has to say both things.
describe('verdictEntry — pass-with-survivors', () => {
  it('labels a green gate with claimed survivors as a PASS that names them', () => {
    const greenGrade = { ...grade, gate: { ...grade.gate, terminator: 'PASS', fails: [], failCount: 0, exit: 0 }, verified: true }
    const text = verdictEntry({ spec: { id: 'c8' }, wave: 3, row, grade: greenGrade,
      decision: { kind: 'pass-with-survivors', survivors: ['gilded/ui/x.py:3'], why: 'sealed gate PASS, suite gate PASS, sweep 6/25, 1 survivor(s) — 1 inside a claimed file: gilded/ui/x.py:3' },
      ideationRecord: null, economicsLines: [] })
    expect(text).toMatch(/^Verdict: \*\*CAMPAIGN PASS \(sweep survivors: 1\)\*\* — sealed gate PASS/m)
  })
})

describe('verdictEntry — denial table and cap proposal', () => {
  const spec = { id: 'c8', invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true } }
  it('prints one Denials line per invariant and the proposal when raised', () => {
    const denialAnalysis = { invariants: [
      { invariant: 'edit-gap', denials: 80, complied: 2, changed: 3, compliedRate: 0.025, ci: [0.01, 0.09], baseRate: 0.3, p: 0.0001, pAdjusted: 0.0002, verdict: 'INERT' },
      { invariant: 'commit-gap', denials: 0, complied: 0, changed: 0, compliedRate: null, ci: [0, 1], baseRate: 0.05, p: null, pAdjusted: null, verdict: 'TOO FEW' },
      { invariant: 'revert', denials: 1, complied: 1, changed: 0, compliedRate: 1, ci: [0.2, 1], baseRate: 1, p: null, pAdjusted: null, verdict: 'IDENTITY' } ] }
    const capProposal = { type: 'Parameter', name: 'invariants/editGapCap', newValue: 60, currentValue: 40, bounds: { min: 40, max: 80 }, status: 'pending', evidence: denialAnalysis.invariants[0] }
    const text = verdictEntry({ spec, wave: 3, row, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [], denialAnalysis, capProposal })
    expect(text).toMatch(/Denials \(campaign to date\): edit-gap 2\/80 complied \(quiet rate 30\.0%, INERT\); commit-gap 0\/0 \(TOO FEW\); revert 1\/1 \(IDENTITY\)\./)
    expect(text).toMatch(/PROPOSAL invariants\/editGapCap 40 → 60 \(max 80\) — approve with --approve-proposal invariants\/editGapCap/)
  })
  // §D: the PROPOSAL line prints the EFFECTIVE cap the proposal raised from
  // (capProposal.currentValue), not the spec's original cap — an override of
  // 60 already in force must show 60, not spec.invariants.editGapCap (40).
  it('prints the effective cap the proposal raised from, not the spec cap, when an override is in force', () => {
    const capProposal = { type: 'Parameter', name: 'invariants/editGapCap', newValue: 80, currentValue: 60, bounds: { min: 40, max: 80 }, status: 'pending', evidence: { verdict: 'INERT' } }
    const text = verdictEntry({ spec, wave: 3, row, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [], capProposal })
    expect(text).toMatch(/PROPOSAL invariants\/editGapCap 60 → 80 \(max 80\) — approve with --approve-proposal invariants\/editGapCap/)
  })
  it('omits both lines when no analysis is available', () => {
    const text = verdictEntry({ spec, wave: 3, row, grade, decision: { kind: 'next', why: 'x' }, ideationRecord: null, economicsLines: [] })
    expect(text).not.toMatch(/Denials \(campaign/); expect(text).not.toMatch(/PROPOSAL/)
  })
})
