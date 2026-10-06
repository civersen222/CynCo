import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolExecutor } from '../../tools/executor.js'

function exec(grader: any, approve: boolean) {
  const asked: string[] = []
  const ex = new ToolExecutor({ cwd: mkdtempSync(join(tmpdir(), 'cynco-grader-')), requestApproval: async (tool) => { asked.push(tool); return approve }, grader })
  return { ex, asked }
}

describe('ToolExecutor grader', () => {
  it('safe runs without asking even for Bash (tier approval)', async () => {
    const { ex, asked } = exec(() => ({ level: 'safe', reason: '' }), false)
    const r = await ex.execute('Bash', { command: 'echo hi' })
    expect(r.isError).toBe(false)
    expect(asked).toEqual([])
  })
  it('risky asks and honours a denial', async () => {
    const { ex, asked } = exec(() => ({ level: 'risky', reason: 'downloads need your approval' }), false)
    const r = await ex.execute('Bash', { command: 'echo hi' })
    expect(asked).toEqual(['Bash'])
    expect(r).toEqual({ output: 'Tool call denied by user: Bash', isError: true })
  })
  it('dangerous is refused with the reason, never asked', async () => {
    const { ex, asked } = exec(() => ({ level: 'dangerous', reason: 'outside the project folder: C:/x' }), true)
    const r = await ex.execute('Read', { file_path: 'C:/x' })
    expect(asked).toEqual([])
    expect(r).toEqual({ output: 'Refused: outside the project folder: C:/x', isError: true })
  })
  it('a download under a grader is NOT refused by the approve-all gate; it asks', async () => {
    const asked: string[] = []
    const ex = new ToolExecutor({ cwd: process.cwd(), requestApproval: async (t) => { asked.push(t); return false }, approveAll: true, grader: () => ({ level: 'risky', reason: 'downloads need your approval' }) })
    const r = await ex.execute('Bash', { command: 'curl https://x' })
    expect(asked).toEqual(['Bash'])
    expect(r.output).toMatch(/denied by user/)
  })
  it('setGrader(null) restores the ordinary tier path', async () => {
    const { ex, asked } = exec(() => ({ level: 'safe', reason: '' }), false)
    ex.setGrader(null)
    await ex.execute('Bash', { command: 'echo hi' })
    expect(asked).toEqual(['Bash'])
  })
})
