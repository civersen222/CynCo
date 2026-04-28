import { describe, expect, it } from 'bun:test'
import { RecursiveVSM } from '../../vsm/recursive.js'

describe('RecursiveVSM', () => {
  it('creates root node with level 0 and idle status', () => {
    const vsm = new RecursiveVSM('SystemRoot')
    expect(vsm.root.name).toBe('SystemRoot')
    expect(vsm.root.level).toBe(0)
    expect(vsm.root.status).toBe('idle')
    expect(vsm.root.children).toHaveLength(0)
  })

  it('adds agents as children at level 1', () => {
    const vsm = new RecursiveVSM('Root')
    vsm.addAgent('Planner', ['Read', 'Bash'])
    vsm.addAgent('Executor', ['Write', 'Edit'])

    expect(vsm.root.children).toHaveLength(2)
    expect(vsm.agentCount).toBe(2)

    const planner = vsm.getAgent('Planner')
    expect(planner).toBeDefined()
    expect(planner?.level).toBe(1)
    expect(planner?.tools).toEqual(['Read', 'Bash'])

    const executor = vsm.getAgent('Executor')
    expect(executor?.level).toBe(1)
  })

  it('tracks and updates agent status', () => {
    const vsm = new RecursiveVSM('Root')
    vsm.addAgent('Worker', ['Bash'])

    vsm.setAgentStatus('Worker', 'running')
    expect(vsm.getAgent('Worker')?.status).toBe('running')

    vsm.setAgentStatus('Worker', 'completed')
    expect(vsm.getAgent('Worker')?.status).toBe('completed')

    vsm.setAgentStatus('Worker', 'failed')
    expect(vsm.getAgent('Worker')?.status).toBe('failed')
  })

  it('enforces depth limit — throws when level >= maxDepth', () => {
    // maxDepth=3 means levels 0,1,2 are valid; level 3 would be forbidden
    const vsm = new RecursiveVSM('Root', 3)
    vsm.addAgent('L1', [])                         // level 1 — ok
    vsm.addSubAgent('L1', 'L2', [])                // level 2 — ok
    // level 2+1=3 >= maxDepth(3) — should throw
    expect(() => vsm.addSubAgent('L2', 'L3', [])).toThrow()
  })

  it('getSummary returns tree view with status icons and levels', () => {
    const vsm = new RecursiveVSM('Root')
    vsm.addAgent('Alpha', ['Read'])
    vsm.addAgent('Beta', ['Write'])
    vsm.setAgentStatus('Alpha', 'running')

    const summary = vsm.getSummary()
    expect(summary).toContain('Root')
    expect(summary).toContain('Alpha')
    expect(summary).toContain('Beta')
    expect(summary).toContain('L0')
    expect(summary).toContain('L1')
    // Running icon for Alpha
    expect(summary).toContain('●')
  })
})
