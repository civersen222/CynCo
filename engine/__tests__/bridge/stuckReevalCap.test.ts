/**
 * F157: the stuck-loop live re-evaluation narrowed the offered tools on any
 * `decision.tools` without consulting LOCALCODE_S5_ENFORCE — a capped headless
 * mission (F7) still had C7 narrow its tools, and no s5.decision frame recorded
 * it. It now asks the same predicate as every other S5 apply site.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyStuckReevalRestriction } from '../../bridge/s5Restriction.js'
import { RuleAuthority, isEnforced } from '../../s5/ruleAuthority.js'
import { isS5EnforcementEnabled } from '../../config.js'

const tools = ['Read', 'Edit', 'Bash', 'Grep'].map(name => ({ name }))
const C7 = ['Read', 'Grep']

describe('applyStuckReevalRestriction', () => {
  const prior = process.env.LOCALCODE_S5_ENFORCE
  afterEach(() => {
    if (prior === undefined) delete process.env.LOCALCODE_S5_ENFORCE
    else process.env.LOCALCODE_S5_ENFORCE = prior
  })

  it('stuck ≥ 5, ENFORCE=false, no verdict file: the C7 restriction is NOT applied', () => {
    process.env.LOCALCODE_S5_ENFORCE = 'false'
    const authority = RuleAuthority.legacy().authorityOf(['C7'])
    expect(authority).toBe('legacy')
    const r = applyStuckReevalRestriction(tools, C7, isEnforced(isS5EnforcementEnabled(), authority))
    expect(r.outcome).toBe('withheld')
    expect(r.tools).toBe(tools)
  })

  it('enforcement on and legacy: applied, as before', () => {
    process.env.LOCALCODE_S5_ENFORCE = 'true'
    const r = applyStuckReevalRestriction(tools, C7, isEnforced(isS5EnforcementEnabled(), 'legacy'))
    expect(r.outcome).toBe('applied')
    expect(r.tools.map(t => t.name)).toEqual(C7)
  })

  it('enforcement on but advisory: withheld', () => {
    expect(applyStuckReevalRestriction(tools, C7, isEnforced(true, 'advisory')).outcome).toBe('withheld')
  })

  it('never narrows to nothing, and a decision with no restriction is a no-op', () => {
    expect(applyStuckReevalRestriction(tools, ['Nope'], true)).toEqual({ tools, outcome: 'empty' })
    expect(applyStuckReevalRestriction(tools, null, true)).toEqual({ tools, outcome: 'none' })
  })
})

describe('the loop wires the re-eval through the helper and records it', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'bridge', 'conversationLoop.ts'), 'utf-8')
  const block = src.slice(src.indexOf("userMessage: 'stuck loop re-evaluation'"), src.indexOf('[s5] Live re-eval failed'))

  it('computes enforced from the cap AND the authority, and narrows only via the helper', () => {
    expect(block).toContain('isEnforced(reevalEnforce, reevalAuthority)')
    expect(block).toContain('applyStuckReevalRestriction(iterationTools, decision.tools, reevalEnforced)')
    // No hand-rolled narrowing left beside the helper.
    expect(block).not.toMatch(/new Set\(decision\.tools\)/)
  })

  it('emits an s5.decision frame carrying enforced and authority', () => {
    expect(block).toMatch(/type: 's5\.decision'[\s\S]*enforced: reevalEnforced,[\s\S]*authority: reevalAuthority,[\s\S]*source: 'stuck-reeval'/)
  })
})
