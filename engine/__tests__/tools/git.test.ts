import { describe, expect, it } from 'bun:test'
const SKIP_ENV = !process.env.CYNCO_INTEGRATION
import { gitTool } from '../../tools/impl/git.js'

describe('Git tool', () => {
  it('has correct metadata', () => {
    expect(gitTool.name).toBe('Git')
    expect(gitTool.tier).toBe('approval')
  })

  it.skipIf(SKIP_ENV)('runs git status', async () => {
    const result = await gitTool.execute({ subcommand: 'status' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('branch')
  })

  it.skipIf(SKIP_ENV)('runs git log', async () => {
    const result = await gitTool.execute({ subcommand: 'log', args: '--oneline -5' }, process.cwd())
    expect(result.isError).toBe(false)
  })

  it('rejects dangerous commands', async () => {
    const result = await gitTool.execute({ subcommand: 'push', args: '--force' }, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous')
  })
})
