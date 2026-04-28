import { describe, expect, it, mock } from 'bun:test'
import { ToolExecutor } from '../../tools/executor.js'

describe('ToolExecutor', () => {
  it('executes an auto-approve tool without requesting approval', async () => {
    const requestApproval = mock(() => Promise.resolve(true))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Read', { file_path: __filename })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('import')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('requests approval for approval-tier tools', async () => {
    const requestApproval = mock(() => Promise.resolve(true))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Bash', { command: 'echo test' })
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
    expect(result.output.trim()).toBe('test')
  })

  it('returns denial message when user denies', async () => {
    const requestApproval = mock(() => Promise.resolve(false))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Bash', { command: 'echo test' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('denied')
  })

  it('returns error for unknown tool', async () => {
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval: async () => true,
    })

    const result = await executor.execute('NonExistent', {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('unknown tool')
  })
})
