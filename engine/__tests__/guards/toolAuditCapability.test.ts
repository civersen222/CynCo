/**
 * F242, slice S5: the engine says `tool-audit` only when this process appended and fsynced a probe
 * record just now, in the folder its run context names. A word for the safe state: the driver refuses
 * an engine that does not say it (`containmentDispatchRefusal`), and an interactive engine, which does
 * not audit, never says it. The live probe is shown against a marked temp folder (auditWorld).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAP_CONTAINED,
  CAP_PATH_GUARD,
  CAP_SEALED_GATES,
  CAP_TOOL_AUDIT,
  governanceCapabilities,
} from '../../bridge/capabilities.js'
import { setRunContainment } from '../../containment.js'
// @ts-ignore — untyped harness module
import { CAP_TOOL_AUDIT as CONTRACT_TOOL_AUDIT, containmentDispatchRefusal } from '../../../scripts/cynco-contract.mjs'
import { auditWorld, type AuditWorld } from '../audit/auditWorld.js'

const worlds: AuditWorld[] = []
afterEach(() => {
  setRunContainment(null)
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.cleanup()
})

/** A wiring whose other guarantees hold, so only the tool-audit member decides the word. */
const wiring = (toolAudit?: () => boolean) => ({
  seal: () => {},
  probe: () => true,
  unseal: () => {},
  s5Enforcing: () => false,
  contained: () => 'verified' as const,
  pathGuard: () => true,
  ...(toolAudit ? { toolAudit } : {}),
})

describe('governanceCapabilities: tool-audit is measured, never claimed', () => {
  it('advertises tool-audit when the probe answers true', () => {
    expect(governanceCapabilities(wiring(() => true))).toContain(CAP_TOOL_AUDIT)
  })

  it('does not advertise it when the probe answers false, throws, or is absent', () => {
    expect(governanceCapabilities(wiring(() => false))).not.toContain(CAP_TOOL_AUDIT)
    expect(governanceCapabilities(wiring())).not.toContain(CAP_TOOL_AUDIT)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const caps = governanceCapabilities(wiring(() => { throw new Error('probe broke') }))
    expect(caps).not.toContain(CAP_TOOL_AUDIT)
    expect(caps).toContain(CAP_SEALED_GATES)
    expect(caps).toContain(CAP_CONTAINED)
    expect(caps).toContain(CAP_PATH_GUARD)
  })

  it('the live wiring: no context, no word; a context over a marked folder writes a probe record and says it', () => {
    expect(governanceCapabilities()).not.toContain(CAP_TOOL_AUDIT)
    const w = auditWorld()
    worlds.push(w)
    setRunContainment(w.ctx)
    expect(governanceCapabilities()).toContain(CAP_TOOL_AUDIT)
    const probes = w.records().filter(r => r.kind === 'probe')
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({ by: 'capability', run: w.ctx.runId })
  })

  it('the live wiring over an unmarked folder does not say it, and logs why', () => {
    const w = auditWorld({ marked: false })
    worlds.push(w)
    setRunContainment(w.ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(governanceCapabilities()).not.toContain(CAP_TOOL_AUDIT)
    expect(log.mock.calls.some(c => String(c[0]).startsWith(`[capability] ${CAP_TOOL_AUDIT} not advertised: audit-dir-foreign: `))).toBe(true)
  })

  it('the engine and the driver spell the word the same way', () => {
    expect(CAP_TOOL_AUDIT).toBe('tool-audit')
    expect(CONTRACT_TOOL_AUDIT).toBe(CAP_TOOL_AUDIT)
  })
})

describe('containmentDispatchRefusal requires tool-audit', () => {
  it('names tool-audit when only that word is missing, and dispatches once it is there', () => {
    for (const platform of ['win32', 'linux']) {
      const r = containmentDispatchRefusal({ capabilities: [CAP_CONTAINED, CAP_PATH_GUARD], platform })
      expect(typeof r).toBe('string')
      expect(r).toContain(`${CAP_TOOL_AUDIT} is absent`)
      expect(r).toContain('Nothing was dispatched.')
      expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED, CAP_PATH_GUARD, CAP_TOOL_AUDIT], platform })).toBeNull()
    }
  })
})
