import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { calibrate } from '../cynco-campaign-calibrate.mjs'

const baseLog = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')
const spec = { id: 'c8', repo: 'C:/repo', base: '1d03308', gate: 'C:/h/gate_c8.py', perturb: 'C:/h/perturb_c8.py', suiteBaseline: 'C:/h/suite_baseline_1d03308.txt' }
const header = '# EXPECT-FLIP: C8.5.palette.Atlas C8.5.river-reserved\n# MUST-FAIL: C8.1b C8.1c C8.2b\nimport os\n'

function io({ perturbLog, baselineExists }) {
  const writes = []
  return { writes,
    run: (cmd, args, opts) => {
      const k = [cmd, ...args].join(' ')
      if (/git -C "?C:\/repo"? archive/.test(k) || /tar/.test(k)) return { status: 0, stdout: '', stderr: '' }
      if (/gate_c8\.py/.test(k)) { expect(opts.env.CYNCO_GATE_REPO).toBe('C:/tmp/c8_base'); return { status: 1, stdout: baseLog, stderr: '' } }
      if (/perturb_c8\.py/.test(k)) return { status: 1, stdout: perturbLog, stderr: '' }
      if (/pytest/.test(k)) return { status: 1, stdout: 'FAILED gilded/tests/a.py::t1 - AssertionError\nFAILED gilded/tests/b.py::t2 - x\n2 failed, 100 passed\n', stderr: '' }
      throw new Error('unscripted ' + k)
    },
    exists: (p) => p === spec.suiteBaseline ? baselineExists : true,
    readFile: (p) => p === spec.perturb ? header : '',
    writeFile: (p, s) => writes.push({ p, s }),
    sha256: (p) => `sha-${p.split('/').pop()}`,
  }
}

describe('calibrate', () => {
  it('passes a clean BASE + honest perturb and writes the suite baseline when missing', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: false })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.baseFails).toHaveLength(14)
    // The three PASS lines at BASE (C8.4c, C8.5.river-reserved, C8.9) are what
    // wave 1's brief prints as "Already PASS at BASE and must stay so"; wave 1
    // shipped without them because calibrate never returned them.
    expect(r.basePasses.map(p => p.id)).toEqual(['C8.4c.beds-honour-mute', 'C8.5.river-reserved', 'C8.9'])
    expect(r.gateSha256).toBe('sha-gate_c8.py')
    expect(r.perturbSha256).toBe('sha-perturb_c8.py')
    expect(r.suiteBaselineCreated).toBe(true)
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0].p).toBe(spec.suiteBaseline)
    expect(fake.writes[0].s).toMatch(/gilded\/tests\/a\.py::t1\ngilded\/tests\/b\.py::t2/)
    expect(fake.writes[0].s).toMatch(/^# standing failures of gilded\/tests at 1d03308, measured \d{4}-\d{2}-\d{2} by cynco-campaign calibrate\n/)
  })

  it('refuses when a discriminator flips', async () => {
    const perturbLog = baseLog.replace('C8.1b.tiers-differ: FAIL', 'C8.1b.tiers-differ: PASS').replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/C8\.1b/)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(fake.writes).toHaveLength(0)
  })

  it('does not rewrite an existing suite baseline', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(fake.writes).toHaveLength(0)
  })

  it('refuses when the perturb header is missing its declarations', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    fake.readFile = () => 'import os\n'
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/EXPECT-FLIP/)
  })

  it('refuses when git archive of the BASE fails', async () => {
    const fake = io({ perturbLog: baseLog, baselineExists: true })
    fake.run = (cmd, args) => {
      const k = [cmd, ...args].join(' ')
      if (/archive/.test(k)) return { status: 128, stdout: '', stderr: 'fatal: not a valid object name\n' }
      throw new Error('unscripted ' + k)
    }
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/git archive 1d03308 failed: fatal: not a valid object name/)
  })
})
