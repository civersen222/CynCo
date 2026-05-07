import { describe, it, expect } from 'bun:test'
import { researchWorkflow } from '../../workflows/definitions/research.js'
import { WorkflowEngine } from '../../workflows/engine.js'
import { getWorkflow } from '../../workflows/index.js'

describe('Research workflow', () => {
  it('has correct structure', () => {
    expect(researchWorkflow.name).toBe('research')
    expect(researchWorkflow.displayName).toBe('Deep Research')
    expect(researchWorkflow.initialPhase).toBe('scope')
    expect(Object.keys(researchWorkflow.phases)).toEqual([
      'scope', 'decompose', 'gather', 'synthesize', 'report', 'index',
    ])
  })
  it('follows happy path: scope → decompose → gather → synthesize → report → index → done', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    expect(engine.currentPhase?.name).toBe('scope')
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('index')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })
  it('supports synthesize → gather loop', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    expect(engine.currentPhase?.name).toBe('report')
  })
  it('scope phase allows CodeIndex and WebSearch', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('CodeIndex')
    expect(tools).toContain('WebSearch')
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Write')
  })
  it('gather phase allows SubAgent and CollectAgent', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('SubAgent')
    expect(tools).toContain('CollectAgent')
    expect(tools).toContain('WebSearch')
    expect(tools).toContain('WebFetch')
  })
  it('report phase allows Write', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('Write')
    expect(tools).toContain('Read')
  })
  it('index phase allows IndexResearch', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('index')
    const tools = engine.getAllowedTools()!
    expect(tools).toContain('IndexResearch')
  })
  it('report can skip directly to done', () => {
    const engine = new WorkflowEngine()
    engine.start(researchWorkflow)
    engine.advance('decompose')
    engine.advance('gather')
    engine.advance('synthesize')
    engine.advance('report')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })
  it('is registered as /research workflow', () => {
    const wf = getWorkflow('/research')
    expect(wf).toBeDefined()
    expect(wf!.name).toBe('research')
  })
})
