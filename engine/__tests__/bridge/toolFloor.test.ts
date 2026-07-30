import { describe, it, expect } from 'vitest'
import { applyToolFloor, attributeRemoval, ENFORCEMENT_REQUIRED_TOOLS } from '../../bridge/toolFloor.js'

const t = (name: string) => ({ name })
const ALL = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ContractAssertPass', 'ContractAssertFail', 'ContractStatus'].map(t)

describe('applyToolFloor', () => {
  it('is a no-op when enforcement is not active', () => {
    const offered = [t('Read')]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: false })
    expect(v.kind).toBe('ok')
    expect(v.tools).toBe(offered)
  })

  it('is a no-op when every required tool is already offered', () => {
    const offered = [t('Read'), ...ENFORCEMENT_REQUIRED_TOOLS.map(t)]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    expect(v.kind).toBe('ok')
  })

  it('restores tools an automatic layer removed (the TDD workflow phase case)', () => {
    // The tdd write_test phase allows Read/Glob/Grep/Write/Edit/SubAgent/
    // CollectAgent; the last two aren't in this fixture's ALL, so five here.
    const offered = ['Read', 'Glob', 'Grep', 'Write', 'Edit'].map(t)
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    expect(v.kind).toBe('restored')
    if (v.kind !== 'restored') return
    expect(v.restored).toContain('Bash')
    expect(v.restored).toContain('ContractAssertPass')
    expect(v.tools.map(x => x.name)).toEqual(expect.arrayContaining(['Read', 'Bash', 'ContractAssertPass']))
  })

  it('does not duplicate a tool that was only partly missing', () => {
    const offered = [t('Bash'), t('Read')]
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: null, enforcementActive: true })
    if (v.kind !== 'restored') throw new Error('expected restored')
    const names = v.tools.map(x => x.name)
    expect(names.filter(n => n === 'Bash')).toHaveLength(1)
  })

  it('reports unsatisfiable rather than overriding an operator pin', () => {
    // The real S4_DET2 task JSON: no ContractAssertPass.
    const offered = ['Read', 'Write', 'Edit', 'Bash'].map(t)
    const v = applyToolFloor({
      offered,
      allTools: ALL,
      operatorPin: ['Read', 'Write', 'Edit', 'Bash'],
      enforcementActive: true,
    })
    expect(v.kind).toBe('unsatisfiable')
    if (v.kind !== 'unsatisfiable') return
    expect(v.missing).toContain('ContractAssertPass')
    expect(v.tools).toBe(offered) // untouched
  })

  it('still restores automatic removals when the operator pin permits them', () => {
    const pin = ['Read', 'Bash', 'ContractAssertPass', 'ContractAssertFail', 'ContractStatus']
    const offered = [t('Read')] // a workflow phase stripped the rest
    const v = applyToolFloor({ offered, allTools: ALL, operatorPin: pin, enforcementActive: true })
    expect(v.kind).toBe('restored')
  })

  it('ignores required tools that are not registered at all', () => {
    const skinny = [t('Read'), t('Bash')]
    const v = applyToolFloor({ offered: [t('Read')], allTools: skinny, operatorPin: null, enforcementActive: true })
    if (v.kind !== 'restored') throw new Error('expected restored')
    expect(v.restored).toEqual(['Bash'])
  })
})

describe('attributeRemoval', () => {
  it('names the workflow phase when its allowedTools excludes the tool', () => {
    expect(attributeRemoval('Bash', { phaseName: 'write_test', phaseAllowed: ['Read', 'Edit'], demoted: [] }))
      .toMatch(/write_test/)
  })

  it('names trust demotion when the phase permits the tool but trust dropped it', () => {
    expect(attributeRemoval('Bash', { phaseName: 'x', phaseAllowed: ['Bash'], demoted: ['Bash'] }))
      .toMatch(/trust/i)
  })

  it('falls back to a generic label', () => {
    expect(attributeRemoval('Bash', { phaseName: null, phaseAllowed: null, demoted: [] }))
      .toMatch(/gating/i)
  })
})
