import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMissionCollector, buildMissionRecord } from '../cynco-ledger.mjs'

/**
 * A ledger row names the prompt arm the ENGINE declared on session.ready
 * (`house-conduct`, engine/bridge/capabilities.ts), so the house-conduct A/B
 * (docs/superpowers/plans/2026-10-27-house-conduct-ab.md) compares arms the
 * engine served rather than labels the operator typed. `null` means the engine
 * never said — an engine older than F41 — and is never read as "off".
 */
describe('engineCapabilities on the row', () => {
  it('records the words the engine said', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'session.ready', capabilities: ['sealed-gates', 's5-earned-only', 'house-conduct'] })
    expect(c.engineCapabilities).toEqual(['sealed-gates', 's5-earned-only', 'house-conduct'])
    expect(buildMissionRecord(c, { missionId: 'x' }).engineCapabilities).toContain('house-conduct')
  })

  it('an engine that said nothing reads null, never []', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'session.ready' })
    expect(c.engineCapabilities).toBeNull()
    expect(buildMissionRecord(c, { missionId: 'x' }).engineCapabilities).toBeNull()
  })

  it('a session.ready with capabilities: [] is a measured empty, not unknown', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'session.ready', capabilities: [] })
    expect(c.engineCapabilities).toEqual([])
  })
})

describe('the arm is visible where the operator looks', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  it('dispatch-mission.sh prints the raw LOCALCODE_HOUSE_CONDUCT it saw', () => {
    const sh = readFileSync(join(here, '..', 'dispatch-mission.sh'), 'utf8')
    expect(sh).toMatch(/echo "\[dispatch\] house conduct: \$\{LOCALCODE_HOUSE_CONDUCT:-unset\}/)
  })
  it('the driver\'s [refusals] line ends with the arm read from the row, with unknown named', () => {
    const driver = readFileSync(join(here, '..', 'cynco-mission-driver.mjs'), 'utf8')
    expect(driver).toContain('record.engineCapabilities')
    expect(driver).toMatch(/prompt arm: \$\{arm\}/)
    expect(driver).toContain("'unknown (engine said no capabilities)'")
  })
})
