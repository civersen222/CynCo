import { describe, expect, it } from 'bun:test'
import { bashTool } from '../../tools/impl/bash.js'
import { tmpdir } from 'os'

describe('Bash tool', () => {
  it('has correct metadata', () => {
    expect(bashTool.name).toBe('Bash')
    expect(bashTool.tier).toBe('approval')
  })

  it('executes a command and returns stdout', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, tmpdir())
    expect(result.isError).toBe(false)
    expect(result.output.trim()).toBe('hello')
  })

  it('returns stderr on failure', async () => {
    const result = await bashTool.execute({ command: 'ls /nonexistent_dir_xyz' }, tmpdir())
    expect(result.isError).toBe(true)
  })

  it('respects timeout', async () => {
    const result = await bashTool.execute({ command: 'sleep 30', timeout: 1000 }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timeout')
  }, 10000)
})
