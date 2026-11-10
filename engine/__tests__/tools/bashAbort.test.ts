/**
 * Stop kills the shell command, and what the command started (F201).
 *
 * The Bash tool had no way to be told the turn was stopped: a Stop waited for
 * the child to finish on its own, up to the command's whole timeout. The
 * command here starts a node process (a grandchild of the shell, as pytest or
 * a build is) that writes a marker after LATE_MS. Stopped, the call returns at
 * once and the marker is never written: the tree is dead, not only the shell.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bashTool } from '../../tools/impl/bash.js'
import { ToolExecutor } from '../../tools/executor.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

const LATE_MS = 2500
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-bash-abort-'))
  dirs.push(d)
  return d
}

/** Double quotes outside, single inside: the same text in bash and PowerShell. */
const writesMarkerLate = `node -e "setTimeout(() => require('fs').writeFileSync('marker.txt', 'x'), ${LATE_MS})"`

describe('the Bash tool and the turn abort signal', () => {
  it('a Stop while a command runs returns at once, says it was stopped, and kills what the command started', async () => {
    const cwd = workdir()
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 400)
    const result = await bashTool.execute({ command: writesMarkerLate }, cwd, ac.signal)
    const ms = Date.now() - started

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/stopped/i)
    expect(result.output).not.toMatch(/timeout/i)
    expect(ms).toBeLessThan(LATE_MS - 300)
    await sleep(LATE_MS - ms + 800)
    expect(existsSync(join(cwd, 'marker.txt')), 'the process the command started outlived the Stop').toBe(false)
  })

  it('a command asked for after the Stop is not started', async () => {
    const cwd = workdir()
    const ac = new AbortController()
    ac.abort()
    const result = await bashTool.execute({ command: `node -e "require('fs').writeFileSync('marker.txt', 'x')"` }, cwd, ac.signal)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/stopped/i)
    expect(existsSync(join(cwd, 'marker.txt'))).toBe(false)
  })

  it('a command that is not stopped runs as before', async () => {
    const cwd = workdir()
    const result = await bashTool.execute({ command: `node -e "require('fs').writeFileSync('marker.txt', 'x')"` }, cwd, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(existsSync(join(cwd, 'marker.txt'))).toBe(true)
  })

  it('the executor hands its caller\'s signal to the tool', async () => {
    const cwd = workdir()
    const ac = new AbortController()
    const executor = new ToolExecutor({ cwd, requestApproval: async () => true, approveAll: true })
    const started = Date.now()
    setTimeout(() => ac.abort(), 400)
    const result = await executor.execute('Bash', { command: writesMarkerLate }, ac.signal)
    expect(result.output).toMatch(/stopped/i)
    expect(Date.now() - started).toBeLessThan(LATE_MS - 300)
  })
})
