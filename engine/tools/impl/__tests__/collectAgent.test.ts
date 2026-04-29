import { describe, test, expect } from 'bun:test'
import { collectAgentTool } from '../collectAgent.js'

describe('collectAgentTool', () => {
  test('has correct name and tier', () => {
    expect(collectAgentTool.name).toBe('CollectAgent')
    expect(collectAgentTool.tier).toBe('auto')
  })

  test('requires agentId', () => {
    expect(collectAgentTool.inputSchema.required).toContain('agentId')
  })

  test('rejects empty agentId', async () => {
    const result = await collectAgentTool.execute({ agentId: '' }, '/tmp')
    expect(result.isError).toBe(true)
  })

  test('returns collect sentinel on valid agentId', async () => {
    const result = await collectAgentTool.execute({ agentId: 'scout-abc123' }, '/tmp')
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed._collectAgent).toBe(true)
    expect(parsed.agentId).toBe('scout-abc123')
  })
})
