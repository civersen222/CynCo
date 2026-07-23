import { describe, it, expect } from 'bun:test'
import { loadToolsTool, resolveRequestedTools } from '../../tools/impl/loadTools.js'

describe('load_tools meta-tool', () => {
  it('is a core tool taking a { tools: string[] } schema', () => {
    expect(loadToolsTool.name).toBe('load_tools')
    expect(loadToolsTool.core).toBe(true)
    expect(loadToolsTool.tier).toBe('auto')
    expect(loadToolsTool.inputSchema.properties.tools).toBeDefined()
    expect(loadToolsTool.inputSchema.required).toEqual(['tools'])
  })

  it('resolveRequestedTools splits known registry names from unknown', async () => {
    const { resolved, unknown } = await resolveRequestedTools(['WebFetch', 'Nope', 'WebSearch'])
    expect(resolved).toEqual(['WebFetch', 'WebSearch'])
    expect(unknown).toEqual(['Nope'])
  })

  it('execute confirms resolved names and notes ignored unknowns', async () => {
    const res = await loadToolsTool.execute({ tools: ['WebFetch', 'Bogus'] }, process.cwd())
    expect(res.isError).toBe(false)
    expect(res.output).toContain('WebFetch')
    expect(res.output).toContain('Bogus')
  })

  it('execute errors when tools is missing or not an array', async () => {
    const res = await loadToolsTool.execute({}, process.cwd())
    expect(res.isError).toBe(true)
  })
})
