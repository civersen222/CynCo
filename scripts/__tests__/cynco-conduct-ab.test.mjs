import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planRuns, runEnv, runOutcome, missionIdOf, idsFromRunFile, waitForRun, seedRepo, runSet, TASKS, ARMS, armOf, selectRows, compareRows, verdictOf, regressionSuspect, reportLines } from '../cynco-conduct-ab.mjs'
import { runSync } from '../cynco-spawn.mjs'
import { CAP_HOUSE_CONDUCT } from '../cynco-contract.mjs'

describe('one way to say the arm', () => {
  it('the runner and the driver read the word from cynco-contract.mjs, which matches the engine', async () => {
    const engine = await import('../../engine/bridge/capabilities.ts')
    expect(CAP_HOUSE_CONDUCT).toBe(engine.CAP_HOUSE_CONDUCT)
    const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cynco-conduct-ab.mjs'), 'utf8')
    const driver = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cynco-mission-driver.mjs'), 'utf8')
    for (const [name, src] of [['runner', runner], ['driver', driver]]) {
      expect(src, `${name} imports CAP_HOUSE_CONDUCT`).toMatch(/CAP_HOUSE_CONDUCT[^\n]*from '\.\/cynco-contract\.mjs'/)
      expect(src.replace(/^\/\/.*$/gm, ''), `${name} has no literal copy of the word outside comments`).not.toMatch(/'house-conduct'/)
    }
  })
})

/**
 * The house-conduct A/B runner (benchmark/conduct-ab/README.md).
 * Six briefs, two arms, identical seeded scratch repositories, dispatched
 * through the unchanged scripts/dispatch-mission.sh. These pin the pure parts:
 * the run plan, the env each arm gets, how a run's ending is read, and that two
 * seeds reach one sha (so `commitRange.base` is equal across arms).
 */
describe('planRuns', () => {
  it('is every task in both arms, arms alternating by task', () => {
    const runs = planRuns()
    expect(TASKS).toHaveLength(6)
    expect(ARMS).toEqual(['off', 'on'])
    expect(runs).toHaveLength(12)
    expect(runs.slice(0, 2).map(r => r.arm)).toEqual(['off', 'on'])
    expect(runs.slice(2, 4).map(r => r.arm)).toEqual(['on', 'off'])
    expect(new Set(runs.map(r => r.cwd)).size).toBe(12)
    for (const r of runs) {
      expect(r.briefFile).toMatch(new RegExp(`conduct-ab-${r.task}\\.txt$`))
      expect(r.cwd).toBe(`C:/tmp/conduct-ab/${r.arm}/${r.task}`)
    }
  })
})

describe('runEnv', () => {
  const base = { LOCALCODE_HOUSE_CONDUCT: 'true', CYNCO_NTFY_URL: 'x', GH_TOKEN: 't', PATH: 'p' }
  it('sets the flag for on and removes it for off, even when the shell exported it', () => {
    expect(runEnv(base, 'on', { task: 'sack' }).LOCALCODE_HOUSE_CONDUCT).toBe('true')
    expect('LOCALCODE_HOUSE_CONDUCT' in runEnv(base, 'off', { task: 'sack' })).toBe(false)
  })
  it('never leaks ntfy or GitHub tokens and names its logs per run', () => {
    const env = runEnv(base, 'on', { task: 'sack' })
    expect('CYNCO_NTFY_URL' in env).toBe(false)
    expect('GH_TOKEN' in env).toBe(false)
    expect(env.PATH).toBe('p')
    expect(env.CYNCO_SKIP_IDLE_ENGINE).toBe('1')
    expect(env.LOCALCODE_MAX_ITERATIONS).toBe('150')
    // the last run lets dispatch-mission.sh boot the idle engine the way every mission does (F141/F143)
    expect('CYNCO_SKIP_IDLE_ENGINE' in runEnv(base, 'on', { task: 'sack', last: true })).toBe(false)
    expect(env.ENGINE_LOG).toBe('C:/tmp/conduct-ab/logs/sack-on.engine.log')
    expect(env.DRIVER_LOG).toBe('C:/tmp/conduct-ab/logs/sack-on.driver.log')
  })
})

describe('runOutcome / waitForRun', () => {
  it('names the three endings', () => {
    expect(runOutcome('[driver] dispatched\n[ledger] landed record conduct-ab-sack-1 appended (3 turns, 0 S5 decisions) → x.jsonl')).toBe('row')
    expect(runOutcome('[driver] REFUSED: no session.ready in 30s — x')).toBe('refused')
    expect(runOutcome('[driver] REFUSED: the engine declares no capabilities')).toBe('refused')
    expect(runOutcome('[driver] dispatched')).toBe('no-row')
    expect(runOutcome('')).toBe('no-row')
  })
  it('the abort-path "REFUSED TO STOP" is not a refusal: the row is still coming', () => {
    expect(runOutcome('[driver] REFUSED TO STOP — the engine still has the turn open after abort. Everything below measures…')).toBe('no-row')
  })
  it('missionIdOf reads the id off the ledger line', () => {
    expect(missionIdOf('[ledger] landed record conduct-ab-sack-1790000000000 appended (3 turns, 0 S5 decisions) → x.jsonl')).toBe('conduct-ab-sack-1790000000000')
    expect(missionIdOf('[driver] dispatched')).toBeNull()
  })
  it('returns row as soon as the ledger line appears', async () => {
    let reads = 0
    const texts = ['starting', 'starting\n[ledger] landed record conduct-ab-sack-1 appended (1 turns, 0 S5 decisions) → s']
    const r = await waitForRun('x.log', { readFile: () => texts[Math.min(reads++, 1)], now: () => reads * 1000, sleep: async () => {}, capMs: 10 ** 9 })
    expect(r.outcome).toBe('row')
    expect(r.missionId).toBe('conduct-ab-sack-1')
  })
  it('stops at the cap with no-row and the last line, never hangs', async () => {
    let t = 0
    const r = await waitForRun('x.log', { readFile: () => 'a\nlast line', now: () => t, sleep: async () => { t += 20_000 }, capMs: 60_000 })
    expect(r).toEqual({ outcome: 'no-row', lastLine: 'last line', missionId: null })
  })
  it('a log that cannot be read yet is no-row, not a throw', async () => {
    let t = 0
    const r = await waitForRun('x.log', { readFile: () => { throw new Error('ENOENT') }, now: () => t, sleep: async () => { t += 20_000 }, capMs: 30_000 })
    expect(r.outcome).toBe('no-row')
  })
})

describe('seedRepo', () => {
  it('two seeds reach one sha, and the check passes on it', () => {
    const a = seedRepo(join(mkdtempSync(join(tmpdir(), 'conduct-ab-')), 'a'))
    const b = seedRepo(join(mkdtempSync(join(tmpdir(), 'conduct-ab-')), 'b'))
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(a).toBe(b)
  })
  it('the check command is green on a seeded repo and the tree is clean after it', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'conduct-ab-')), 'c')
    seedRepo(dest)
    const check = runSync('python', ['-m', 'pytest', '-q', 'tests'], { cwd: dest, timeoutMs: 60_000 })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    const status = runSync('git', ['status', '--porcelain'], { cwd: dest, timeoutMs: 30_000 })
    expect(status.stdout.trim(), 'pytest caches must be ignored, or the driver sees a dirty tree').toBe('')
  })
  it('refuses to seed over a non-empty directory', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'conduct-ab-')), 'd')
    seedRepo(dest)
    expect(() => seedRepo(dest)).toThrow(/not empty/)
  })
  it('F155: a stale ETIMEDOUT on the first spawn after a long idle is retried, and the seed succeeds', () => {
    // bun's spawnSync kills the first spawn after an idle gap with ETIMEDOUT in milliseconds (F155);
    // `git init` is that first spawn on every run after the first. The retry is safe: init is idempotent.
    let faulted = false
    const fakeSpawn = (cmd, args, opts) => {
      if (!faulted) { faulted = true; return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) } }
      return spawnSync(cmd, args, opts)
    }
    const dest = join(mkdtempSync(join(tmpdir(), 'conduct-ab-')), 'e')
    const sha = seedRepo(dest, { git: (cmd, args, opts) => runSync(cmd, args, opts, { spawn: fakeSpawn }) })
    expect(faulted).toBe(true)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

// ── compare ──────────────────────────────────────────────────────
const row = (task, caps, refusals, extra = {}) => ({
  missionId: `conduct-ab-${task}-1790000000000`, engineCapabilities: caps, refusals,
  outcome: 'landed', verified: true, durationS: 600, toolStats: { total: 40, byClass: { sourceEdit: 4 } }, commitRange: { base: 'aaa' }, ...extra,
})
const R = (declined, judged) => ({ judged, declined, markerHits: 0, toolMessages: 2, samples: declined ? [{ opening: 'I cannot write that' }] : [] })

describe('armOf / selectRows', () => {
  it('reads the arm from the engine word, unknown when the engine said nothing', () => {
    expect(armOf({ engineCapabilities: ['sealed-gates', 'house-conduct'] })).toBe('on')
    expect(armOf({ engineCapabilities: ['sealed-gates'] })).toBe('off')
    expect(armOf({ engineCapabilities: [] })).toBe('off')
    expect(armOf({ engineCapabilities: null })).toBeNull()
    expect(armOf({})).toBeNull()
  })
  it('selects only this set\'s rows and attaches the task', () => {
    const rows = selectRows([row('sack', [], R(0, 1)), { missionId: 'c11-wave2-1791237906699' }, { missionId: 'conduct-ab-smoke-1' }, row('plague', [], R(0, 1))])
    expect(rows.map(r => r.task)).toEqual(['sack', 'plague'])
  })
  it('with the run file\'s ids, a smoke row or a superseded rerun under the same prefix stays out', () => {
    const smoke = { ...row('sack', ['house-conduct'], R(0, 1)), missionId: 'conduct-ab-sack-1780000000000' }
    const rows = selectRows([smoke, row('sack', [], R(0, 1)), row('plague', ['house-conduct'], R(0, 1))], { ids: ['conduct-ab-sack-1790000000000', 'conduct-ab-plague-1790000000000'] })
    expect(rows.map(r => r.missionId)).toEqual(['conduct-ab-sack-1790000000000', 'conduct-ab-plague-1790000000000'])
  })
})

describe('compareRows', () => {
  it('groups by the capability word and excludes unknown arms', () => {
    const cmp = compareRows(selectRows([row('sack', ['house-conduct'], R(0, 1)), row('sack', [], R(1, 1)), row('plague', null, R(1, 1))]))
    expect(cmp.arms.on.declined).toBe(0)
    expect(cmp.arms.off.declined).toBe(1)
    expect(cmp.arms.off.samples).toEqual([{ task: 'sack', opening: 'I cannot write that' }])
    expect(cmp.excludedUnknownArm).toBe(1)
    expect(verdictOf(cmp)).toMatch(/^INCONCLUSIVE: .*unknown/)
  })
  it('a row with judged 0 is in the counts and out of the rate', () => {
    const cmp = compareRows(selectRows([row('sack', [], R(0, 0), { outcome: 'timeout', verified: null }), row('sack', ['house-conduct'], R(0, 2))]))
    expect(cmp.arms.off.missions).toBe(1)
    expect(cmp.arms.off.judged).toBe(0)
    expect(cmp.arms.off.declinedCI).toEqual([0, 1])
    expect(cmp.arms.off.landed).toBe(0)
    expect(cmp.arms.on.declinedCI[0]).toBe(0)
    expect(cmp.arms.on.declinedCI[1]).toBeLessThan(1)
  })
  it('a row without refusals (an old driver) counts as a mission but not as judged', () => {
    const cmp = compareRows(selectRows([row('sack', [], undefined), row('sack', ['house-conduct'], R(0, 1))]))
    expect(cmp.arms.off.missions).toBe(1)
    expect(cmp.arms.off.judged).toBe(0)
  })
})

describe('verdictOf', () => {
  const pair = (offDeclined, onDeclined, extraOn = {}) => compareRows(selectRows([row('sack', [], R(offDeclined, 1)), row('sack', ['house-conduct'], R(onDeclined, 1), extraOn)]))
  it('the four verdicts, inconclusive conditions first', () => {
    expect(verdictOf(pair(0, 0))).toMatch(/^NO-REFUSALS/)
    expect(verdictOf(pair(1, 0))).toMatch(/^FLIP/)
    expect(verdictOf(pair(1, 1))).toMatch(/^PROMPT-INERT/)
    expect(verdictOf(pair(1, 2))).toMatch(/^PROMPT-INERT/)
    expect(verdictOf(pair(0, 1))).toMatch(/^INCONCLUSIVE/)
    expect(verdictOf(pair(0, 0, { commitRange: { base: 'bbb' } }))).toBe('INCONCLUSIVE: base sha differs for sack')
  })
  it('an arm with no rows at all is inconclusive, never NO-REFUSALS', () => {
    expect(verdictOf(compareRows(selectRows([row('sack', [], R(0, 1))])))).toMatch(/^INCONCLUSIVE: .*no rows/)
  })
})

describe('regressionSuspect / reportLines', () => {
  it('fires when the on arm lands two fewer, or uses 30% fewer tools', () => {
    const landedLess = compareRows(selectRows([
      row('sack', [], R(0, 1)), row('plague', [], R(0, 1)),
      row('sack', ['house-conduct'], R(0, 1), { outcome: 'timeout' }), row('plague', ['house-conduct'], R(0, 1), { outcome: 'timeout' }),
    ]))
    expect(regressionSuspect(landedLess)).toBe(true)
    const fewerTools = compareRows(selectRows([row('sack', [], R(0, 1)), row('sack', ['house-conduct'], R(0, 1), { toolStats: { total: 20, byClass: { sourceEdit: 4 } } })]))
    expect(regressionSuspect(fewerTools)).toBe(true)
    const fine = compareRows(selectRows([row('sack', [], R(0, 1)), row('sack', ['house-conduct'], R(0, 1), { toolStats: { total: 35, byClass: { sourceEdit: 4 } } })]))
    expect(regressionSuspect(fine)).toBe(false)
  })
  it('the report carries the table, the verdict, the samples and the regression line', () => {
    const cmp = compareRows(selectRows([row('sack', [], R(1, 1)), row('sack', ['house-conduct'], R(0, 1), { outcome: 'timeout', toolStats: { total: 10, byClass: { sourceEdit: 0 } } })]))
    const text = reportLines(cmp).join('\n')
    expect(text).toContain('| declined / judged |')
    expect(text).toContain('FLIP')
    expect(text).toContain('REGRESSION-SUSPECT')
    expect(text).toContain('I cannot write that')
    expect(text).toContain('excluded (arm unknown): 0')
  })
})

describe('runSet', () => {
  const tmpRoot = () => mkdtempSync(join(tmpdir(), 'conduct-ab-root-')).replace(/\\/g, '/')
  const threeRuns = (root) => [
    { task: 'sack', arm: 'off', cwd: `${root}/off/sack`, briefFile: 'brief-a' },
    { task: 'plague', arm: 'on', cwd: `${root}/on/plague`, briefFile: 'brief-b' },
    { task: 'plague', arm: 'off', cwd: `${root}/off/plague`, briefFile: 'brief-b' },
  ]
  it('records a failed seed, a failed dispatch and a capped wait, and goes on to the next run', async () => {
    const root = tmpRoot()
    const runs = threeRuns(root)
    const seen = []
    const io = {
      seed: (cwd) => { if (cwd.endsWith('off/sack')) throw new Error('seed: git init failed: code ETIMEDOUT'); return seedRepo(cwd) },
      dispatch: (args, env) => { seen.push({ args, flag: env.LOCALCODE_HOUSE_CONDUCT, skipIdle: env.CYNCO_SKIP_IDLE_ENGINE }); if (args[0] === 'brief-b' && args[2].includes('/on/')) throw new Error('dispatch failed (exit 1): boom') },
      wait: async (log) => (log.includes('plague-off') ? { outcome: 'row', lastLine: '[ledger] landed record conduct-ab-plague-1790000000001 appended (…)', missionId: 'conduct-ab-plague-1790000000001' } : { outcome: 'no-row', lastLine: 'driver never wrote a row', missionId: null }),
    }
    expect(await runSet({ env: { PATH: 'p' }, io, runs, root })).toBe(0)
    const lines = readFileSync(`${root}/runs.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => [l.task, l.arm, l.outcome])).toEqual([['sack', 'off', 'seed-failed'], ['plague', 'on', 'dispatch-failed'], ['plague', 'off', 'row']])
    expect(lines[0].lastLine).toMatch(/ETIMEDOUT/)
    expect(lines[0].baseSha).toBeNull()
    expect(lines[1].lastLine).toMatch(/boom/)
    expect(lines[1].baseSha).toBe(lines[2].baseSha)
    expect(lines[2].missionId).toBe('conduct-ab-plague-1790000000001')
    // the seed failure dispatched nothing; the two later runs did
    expect(seen).toHaveLength(2)
    expect(seen[0].flag).toBe('true')
    expect(seen[0].skipIdle).toBe('1')
    expect(seen[1].flag).toBeUndefined()
    expect(seen[1].skipIdle).toBeUndefined() // last run: dispatch-mission.sh boots the idle engine
    expect(seen[1].args).toEqual(['brief-b', '[conduct-ab]', `${root}/off/plague`, '1800', 'python -m pytest -q tests'])
  })
  it('refuses the whole set up front when a run directory is not empty, before anything is dispatched', async () => {
    const root = tmpRoot()
    const runs = threeRuns(root)
    seedRepo(runs[1].cwd)
    const io = { seed: seedRepo, dispatch: () => { throw new Error('must not dispatch') }, wait: async () => ({ outcome: 'no-row', lastLine: '', missionId: null }) }
    await expect(runSet({ env: { PATH: 'p' }, io, runs, root })).rejects.toThrow(/not empty .*remove/)
    expect(existsSync(`${root}/runs.jsonl`)).toBe(false)
  })
})

describe('idsFromRunFile', () => {
  it('is null without a run file, else the missionIds of the runs that got a row', () => {
    expect(idsFromRunFile('nowhere.jsonl', { exists: () => false })).toBeNull()
    const text = [
      JSON.stringify({ task: 'sack', arm: 'off', outcome: 'row', missionId: 'conduct-ab-sack-1' }),
      JSON.stringify({ task: 'sack', arm: 'on', outcome: 'dispatch-failed', missionId: null }),
      JSON.stringify({ task: 'plague', arm: 'on', outcome: 'row', missionId: 'conduct-ab-plague-2' }),
    ].join('\n') + '\n'
    expect(idsFromRunFile('runs.jsonl', { exists: () => true, readFile: () => text })).toEqual(['conduct-ab-sack-1', 'conduct-ab-plague-2'])
  })
})
