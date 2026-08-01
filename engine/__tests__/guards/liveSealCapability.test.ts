/**
 * F41: a governance guarantee is only as live as the process serving it.
 *
 * Measured on Gilded Wave 9b. The engine daemon serving that mission was started
 * 2026-07-31 20:27:38 from tree 7b49457, in which `engine/tools/sealedPaths.ts`
 * DOES NOT EXIST. F37 — the commit that seals a held-out gate — landed
 * 2026-08-01 03:46:24, seven hours later. The mission ran at ~04:30. So the
 * seal was correct, was on disk, was covered by two wiring guards that pass,
 * and was never loaded by the process that served the mission.
 *
 * The transcript records the consequence exactly: zero sealed refusals in 160
 * messages, and four Bash calls running the held-out gate, the last of them
 * returning its full scorecard at 028338c — the very commit the driver then
 * graded. That gate's PASS is not a held-out measurement and the ledger row had
 * to be re-scored by hand.
 *
 * Every fix in this repo has this failure mode latent in it: the code is the
 * guarantee, the PROCESS is what enforces it, and until now nothing compared
 * the two. A version number could not have caught it either — F37 changed no
 * wire shape, so PROTOCOL_VERSION was correctly left alone.
 *
 * So the engine says what it can enforce, and it says it by MEASURING rather
 * than claiming: `governanceCapabilities` runs the seal against a fabricated
 * path and advertises `sealed-gates` only if the refusal actually comes back.
 * A build that predates F37 cannot say the word at all — the field is absent,
 * which is the signal. Absence is UNKNOWN and unknown is not present: the
 * driver refuses the dispatch rather than running a mission whose held-out gate
 * is, unbeknownst to anyone, in plain sight.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAP_SEALED_GATES,
  governanceCapabilities,
} from '../../bridge/capabilities.js'
import { getTaskSealedPaths, getSealedDirs } from '../../tools/sealedPaths.js'
// @ts-ignore — untyped harness module
import { sealedDispatchRefusal } from '../../../scripts/cynco-contract.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

describe('the engine advertises only what this build can enforce', () => {
  it('advertises sealed-gates on a build where the seal actually refuses', () => {
    expect(governanceCapabilities()).toContain(CAP_SEALED_GATES)
  })

  it('is a measurement, not a claim: a seal that does not refuse is not advertised', () => {
    // The whole point. If the probe were `return [CAP_SEALED_GATES]` this test
    // would fail, because a hardcoded list says the word on a broken build too.
    const caps = governanceCapabilities({
      seal: () => {},
      probe: () => false,
      unseal: () => {},
    })
    expect(caps).not.toContain(CAP_SEALED_GATES)
  })

  it('leaves no sealed state behind, so the probe cannot leak into a task', () => {
    governanceCapabilities()
    expect(getTaskSealedPaths()).toEqual([])
    expect(getSealedDirs()).toEqual([])
  })

  it('probes a path that cannot exist, so no real gate is touched', () => {
    const seen: string[][] = []
    governanceCapabilities({
      seal: (paths) => { seen.push(paths) },
      probe: () => true,
      unseal: () => {},
    })
    expect(seen).toHaveLength(1)
    for (const p of seen[0]) expect(p).toMatch(/capability-probe/)
  })
})

describe('the startup handshake carries the capability list', () => {
  it('session.ready declares a capabilities field', () => {
    expect(read('engine/bridge/protocol.ts')).toMatch(/capabilities\?:\s*string\[\]/)
  })

  it('main.ts fills it from the measurement, not from a literal', () => {
    const src = read('engine/main.ts')
    expect(src).toContain('governanceCapabilities()')
    expect(src).toMatch(/capabilities:\s*governanceCapabilities\(\)/)
  })
})

describe('the driver refuses to dispatch a seal the engine cannot enforce', () => {
  it('refuses when the contract seals something and the engine cannot say the word', () => {
    const refusal = sealedDispatchRefusal({ sealedCount: 2, capabilities: [] })
    expect(refusal).toBeTruthy()
    // Names the seal and the count, so the operator knows which guarantee is
    // missing rather than that "something" was refused.
    expect(refusal).toMatch(/seal/i)
    expect(refusal).toContain('2')
  })

  it('refuses when the engine sent no capabilities at all — absence is not permission', () => {
    // The exact Wave 9b shape: a build that predates F37 emits no such field.
    expect(sealedDispatchRefusal({ sealedCount: 2, capabilities: undefined })).toBeTruthy()
  })

  it('refuses when session.ready never arrived, because unknown is not present', () => {
    expect(sealedDispatchRefusal({ sealedCount: 2, capabilities: null })).toBeTruthy()
  })

  it('dispatches when the engine advertises the seal', () => {
    expect(sealedDispatchRefusal({
      sealedCount: 2, capabilities: [CAP_SEALED_GATES],
    })).toBeNull()
  })

  it('says nothing about a mission with no sealed instrument to protect', () => {
    // Most missions. The guard must not become a reason they stop dispatching.
    expect(sealedDispatchRefusal({ sealedCount: 0, capabilities: undefined })).toBeNull()
  })

  it('the refusal names the remedy, because the operator is the only one who can apply it', () => {
    const refusal = String(sealedDispatchRefusal({ sealedCount: 1, capabilities: [] }))
    expect(refusal).toMatch(/restart/i)
  })
})

describe('the driver consults the guard on the live dispatch path', () => {
  const driver = read('scripts/cynco-mission-driver.mjs')

  it('imports the guard rather than re-deriving the decision', () => {
    expect(driver).toContain('sealedDispatchRefusal')
  })

  it('knows what the contract would seal, so it can tell whether it matters', () => {
    expect(driver).toContain('withheldGatePaths')
  })

  it('a refused dispatch exits instead of waiting out the timeout', () => {
    // F32's lesson: the absence of work has to have its own name. A mission that
    // was never sent must not be recorded as one that ran and produced nothing.
    const guard = driver.slice(driver.indexOf('sealedDispatchRefusal('))
    expect(guard).toMatch(/process\.exit\(/)
  })
})
