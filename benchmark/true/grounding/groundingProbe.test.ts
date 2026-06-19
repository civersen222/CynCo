import { describe, it, expect } from 'vitest'
import { buildConceptTable, probeEdit, isGrounded } from './groundingProbe.js'

// A minimal stand-in for the civkings repo at the green ref: the concept
// "happiness" is defined as a plain field in TWO files AND has an authoritative
// `happiness_system` module — exactly the collision the deepdive runs fell into.
const REPO = [
  { path: 'city.py', content: 'class City:\n    def __init__(self):\n        self.happiness = 0\n' },
  {
    path: 'game.py',
    content:
      'class Game:\n    def __init__(self):\n        self.happiness: Dict[str, int] = {}\n' +
      '        self.happiness_system = HappinessSystem()\n        self.faith_points = {}\n',
  },
  {
    path: 'happiness_system.py',
    content: 'class HappinessSystem:\n    @property\n    def current_happiness(self): return self._h\n' +
      '    def get_production_loss(self): return 1.0\n',
  },
]

describe('buildConceptTable', () => {
  it('marks happiness as a multi-source concept (plain field + _system source)', () => {
    const t = buildConceptTable(REPO)
    expect(t.has('happiness')).toBe(true)
    expect(t.get('happiness')!.systemSource).toBe('happiness_system')
    // it was defined as a plain field in both city.py and game.py
    expect(t.get('happiness')!.plainFields.sort()).toEqual(['city.py', 'game.py'])
  })

  it('does NOT flag concepts that have no competing _system source', () => {
    const t = buildConceptTable(REPO)
    // faith_points is a plain field but there is no faith_points_system — not a collision
    expect(t.has('faith_points')).toBe(false)
  })
})

describe('probeEdit — real signatures from the deepdive runs', () => {
  const table = buildConceptTable(REPO)

  it('FLAGS the failing runs: production driven from the self.happiness dict', () => {
    // governed rep2 / rep3 / rep4 etc. (all FAILED the happiness assertion)
    const added = [
      'happiness = self.happiness.get(owner, 50)',
      'effective_production = raw_production * (happiness / 100.0)',
    ]
    const findings = probeEdit(added, table)
    expect(findings.map((f) => f.concept)).toContain('happiness')
    expect(isGrounded(added, table)).toBe(false)
  })

  it('PASSES the passing run: production driven from happiness_system.current_happiness', () => {
    // ungoverned rep1 (PASSED the happiness assertion)
    const added = [
      'happiness = self.happiness_system.current_happiness',
      'happiness_modifier = happiness / 100.0 if happiness < 40 else 1.0',
    ]
    expect(isGrounded(added, table)).toBe(true)
  })

  it('PASSES use of the canonical get_production_loss() API', () => {
    // ungoverned rep4 referenced the authoritative API (its 0/3 was an unrelated
    // collapse, not a happiness-source error) — the probe must not flag it.
    const added = ['prod_loss = self.happiness_system.get_production_loss()', 'city.production *= prod_loss']
    expect(isGrounded(added, table)).toBe(true)
  })

  it('does not flag an edit that touches neither source', () => {
    const added = ['self.faith_points[owner] += yields.get("faith", 0)']
    expect(isGrounded(added, table)).toBe(true)
  })
})
