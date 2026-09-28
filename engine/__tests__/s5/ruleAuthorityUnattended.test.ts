/**
 * Phase 5 Task 1: with no verdict file (legacy mode), `LOCALCODE_S5_ENFORCE`
 * alone used to decide whether a decision acted — so dispatch-mission.sh pinned
 * it to false for every mission. Legacy is now `advisory` in an unattended
 * mission: only an EARNED rule acts there, whatever the switch says.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RuleAuthority, isEnforced } from '../../s5/ruleAuthority.js'
import { MISSION_ENV_KEYS } from '../../missionEnv.js'

const dirs: string[] = []
const prev = Object.fromEntries(MISSION_ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of MISSION_ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('legacy authority in an unattended mission', () => {
  it('legacy + unattended → advisory, and an advisory decision is never enforced', () => {
    const a = RuleAuthority.legacy()
    const authority = a.authorityOf(['C7'], { unattended: true })
    expect(authority).toBe('advisory')
    expect(isEnforced(true, authority)).toBe(false)
  })

  it('legacy + interactive → legacy, governed by the switch as before', () => {
    const a = RuleAuthority.legacy()
    const authority = a.authorityOf(['C7'], { unattended: false })
    expect(authority).toBe('legacy')
    expect(isEnforced(true, authority)).toBe(true)
    expect(isEnforced(false, authority)).toBe(false)
  })

  it('the default reads the mission env', () => {
    for (const k of MISSION_ENV_KEYS) delete process.env[k]
    expect(RuleAuthority.legacy().authorityOf(['C7'])).toBe('legacy')
    process.env.LOCALCODE_MISSION_MARKER = 'M_DONE'
    expect(RuleAuthority.legacy().authorityOf(['C7'])).toBe('advisory')
  })

  it('earned mode is unchanged by the mission: PREDICTIVE still acts, others stay advisory', () => {
    const d = mkdtempSync(join(tmpdir(), 'cynco-authority-'))
    dirs.push(d)
    const path = join(d, 'rule-verdicts.json')
    writeFileSync(path, JSON.stringify({ schema: 1, rules: { C7: { verdict: 'PREDICTIVE' }, W1: { verdict: 'NOT PREDICTIVE' } } }))
    const a = RuleAuthority.load(path)
    expect(a.authorityOf(['C7'], { unattended: true })).toBe('earned')
    expect(isEnforced(true, a.authorityOf(['C7'], { unattended: true }))).toBe(true)
    expect(a.authorityOf(['W1'], { unattended: true })).toBe('advisory')
  })

  it('the session-start log line says so in a mission, and only there', () => {
    const a = RuleAuthority.legacy()
    expect(a.logLine({ unattended: true })).toBe('[s5] rule authority: legacy (no verdict file) (advisory in this unattended mission)')
    expect(a.logLine({ unattended: false })).toBe('[s5] rule authority: legacy (no verdict file)')
    const missing = RuleAuthority.load(join(tmpdir(), 'cynco-no-such-dir', 'rule-verdicts.json'))
    expect(missing.logLine({ unattended: true })).toMatch(/^\[s5\] rule authority: legacy \(no verdict file at .+\) \(advisory in this unattended mission\)$/)
  })
})
