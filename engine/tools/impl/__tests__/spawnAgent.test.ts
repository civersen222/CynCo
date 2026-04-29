import { describe, test, expect } from 'bun:test'
import { spawnAgentTool } from '../spawnAgent.js'

describe('spawnAgentTool', () => {
  test('has correct name and tier', () => {
    expect(spawnAgentTool.name).toBe('SubAgent')
    expect(spawnAgentTool.tier).toBe('auto')
  })

  test('requires task and persona', () => {
    expect(spawnAgentTool.inputSchema.required).toContain('task')
    expect(spawnAgentTool.inputSchema.required).toContain('persona')
  })

  test('persona enum includes all 5 types', () => {
    const personaProp = spawnAgentTool.inputSchema.properties['persona'] as { enum: string[] }
    expect(personaProp.enum).toContain('scout')
    expect(personaProp.enum).toContain('oracle')
    expect(personaProp.enum).toContain('kraken')
    expect(personaProp.enum).toContain('spark')
    expect(personaProp.enum).toContain('architect')
    expect(personaProp.enum).toHaveLength(5)
  })

  test('rejects invalid persona with error containing "Invalid persona"', async () => {
    const result = await spawnAgentTool.execute(
      { task: 'explore the codebase', persona: 'ninja' },
      '/tmp'
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid persona')
  })

  test('rejects empty task', async () => {
    const result = await spawnAgentTool.execute(
      { task: '', persona: 'scout' },
      '/tmp'
    )
    expect(result.isError).toBe(true)
  })

  test('returns sub-agent sentinel on valid input', async () => {
    const result = await spawnAgentTool.execute(
      { task: 'explore the codebase', persona: 'scout' },
      '/tmp'
    )
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed._subagent).toBe(true)
    expect(parsed.config).toBeDefined()
    expect(parsed.config.task).toBe('explore the codebase')
    expect(parsed.config.persona).toBe('scout')
    expect(parsed.blocking).toBe(true)
  })

  test('blocking defaults to true when not provided', async () => {
    const result = await spawnAgentTool.execute(
      { task: 'some task', persona: 'oracle' },
      '/tmp'
    )
    const parsed = JSON.parse(result.output)
    expect(parsed.blocking).toBe(true)
  })

  test('blocking can be set to false', async () => {
    const result = await spawnAgentTool.execute(
      { task: 'some task', persona: 'spark', blocking: false },
      '/tmp'
    )
    const parsed = JSON.parse(result.output)
    expect(parsed.blocking).toBe(false)
  })
})
