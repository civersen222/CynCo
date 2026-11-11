/**
 * Stop and the timeout kill the shell command, and what the command started
 * (F201, F210).
 *
 * The Bash tool had no way to be told the turn was stopped: a Stop waited for
 * the child to finish on its own, up to the command's whole timeout. And its
 * timeout killed the shell alone. The command here starts a node process (a
 * grandchild of the shell, as pytest or a build is) that writes its pid at
 * once and a marker after LATE_MS, far beyond any test. Stopped or timed out,
 * the call returns long before that and the grandchild is dead.
 *
 * Nothing here is timed against the kill: each test waits for the grandchild
 * to be running before it stops the command, and then for it to be gone. The
 * first version stopped 400 ms after the call began, which is when PowerShell
 * is starting `node`, and failed now and then in a full run (F210: a kill that
 * finds the tree when it happens can miss a child started at that instant;
 * vitest runs on Node, where the Bash tool has no Job Object).
 */
import { describe, expect, it, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bashTool } from '../../tools/impl/bash.js'
import { ToolExecutor } from '../../tools/executor.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

/** The grandchild's own lifetime: no test waits this long. */
const LATE_MS = 60_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-bash-abort-'))
  dirs.push(d)
  writeFileSync(join(d, 'late.js'),
    `require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => require('fs').writeFileSync('marker.txt', 'x'), ${LATE_MS})\n`)
  return d
}

/** The same text in bash and PowerShell. */
const startsGrandchild = 'node late.js'

async function waitFor<T>(read: () => T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(25)
  }
}

/** The grandchild's pid, once it has written it. */
const grandchildPid = (cwd: string) => waitFor(() => {
  if (!existsSync(join(cwd, 'pid.txt'))) return 0
  const n = Number(readFileSync(join(cwd, 'pid.txt'), 'utf-8'))
  return Number.isInteger(n) && n > 0 ? n : 0
}, 'the command to start its child')

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = (pid: number) => waitFor(() => !alive(pid), `pid ${pid} to be gone`, 10_000)

describe('the Bash tool and the turn abort signal', () => {
  it('a Stop while a command runs returns without waiting for it, says it was stopped, and kills what the command started', async () => {
    const cwd = workdir()
    const ac = new AbortController()
    const call = bashTool.execute({ command: startsGrandchild }, cwd, ac.signal)
    const pid = await grandchildPid(cwd)
    const stoppedAt = Date.now()
    ac.abort()
    const result = await call

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/stopped/i)
    expect(result.output).not.toMatch(/timeout/i)
    expect(Date.now() - stoppedAt, 'the call waited for the command instead of killing it').toBeLessThan(LATE_MS / 2)
    await gone(pid)
    expect(existsSync(join(cwd, 'marker.txt')), 'the process the command started outlived the Stop').toBe(false)
  }, 60_000)

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
  }, 30_000)

  it('the executor hands its caller\'s signal to the tool', async () => {
    const cwd = workdir()
    const ac = new AbortController()
    const executor = new ToolExecutor({ cwd, requestApproval: async () => true, approveAll: true })
    const call = executor.execute('Bash', { command: startsGrandchild }, ac.signal)
    const pid = await grandchildPid(cwd)
    ac.abort()
    const result = await call
    expect(result.output).toMatch(/stopped/i)
    await gone(pid)
  }, 60_000)
})

describe('the Bash tool\'s own timeout', () => {
  it('kills what the command started, not only the shell, and still says timeout with the budget it had', async () => {
    const cwd = workdir()
    const started = Date.now()
    const result = await bashTool.execute({ command: startsGrandchild, timeout: 5000 }, cwd)
    const ms = Date.now() - started

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/command timeout after 5000ms/)
    expect(result.output).not.toMatch(/stopped/i)
    expect(ms).toBeGreaterThanOrEqual(4900)
    expect(ms, 'the call waited for the command instead of killing it').toBeLessThan(LATE_MS / 2)
    const pid = await grandchildPid(cwd)
    await gone(pid)
    expect(existsSync(join(cwd, 'marker.txt')), 'the process the command started outlived the timeout').toBe(false)
  }, 60_000)

  it('a command that finishes inside its budget is not touched by the timer', async () => {
    const cwd = workdir()
    const result = await bashTool.execute({ command: `node -e "console.log('done')"`, timeout: 20_000 }, cwd)
    expect(result.isError).toBe(false)
    expect(result.output).toMatch(/done/)
  }, 30_000)
})
