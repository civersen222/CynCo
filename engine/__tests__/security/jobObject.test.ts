/**
 * F131 / feedback_zombie_servers: on Windows a child (llama-server, jlens)
 * outlives a killed engine, holds the port and the VRAM, and the next engine
 * adopts a server whose args nobody can account for. Quartermaster solves it
 * structurally: the process assigns ITSELF to a Job Object with
 * KILL_ON_JOB_CLOSE, so every descendant dies when the job's last handle
 * closes — which is when the engine process ends, however it ends.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { installKillOnCloseJob, JOB_LIMIT_KILL_ON_JOB_CLOSE, JOB_LIMIT_BREAKAWAY_OK } from '../../security/jobObject.js'

const win = process.platform === 'win32'

describe('installKillOnCloseJob', () => {
  it('exposes the two limit flags Quartermaster uses', () => {
    expect(JOB_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000)
    expect(JOB_LIMIT_BREAKAWAY_OK).toBe(0x0800)
  })

  it.skipIf(win)('is a no-op with a reason off Windows', async () => {
    const r = await installKillOnCloseJob()
    expect(r.installed).toBe(false)
    expect(r.reason).toContain('win32')
  })

  it.skipIf(!win)('kills a grandchild when the process that installed the job exits', () => {
    // A throwaway bun process installs the job, spawns ping for 60s, prints
    // the ping pid, and exits abruptly. If the job works, ping is gone.
    const modUrl = new URL('../../security/jobObject.ts', import.meta.url).href
    const script = `
      const { installKillOnCloseJob } = await import(${JSON.stringify(modUrl)})
      const r = await installKillOnCloseJob()
      if (!r.installed) { console.log('NOINSTALL ' + r.reason); process.exit(3) }
      const { spawn } = await import('child_process')
      const c = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      console.log('CHILD ' + c.pid)
      await new Promise(r => setTimeout(r, 1500))
      process.exit(0)
    `
    const run = spawnSync('bun', ['-e', script], { encoding: 'utf-8', timeout: 30000 })
    const m = /CHILD (\d+)/.exec(run.stdout)
    expect(m, `runner output: ${run.stdout} ${run.stderr}`).not.toBeNull()
    const pid = m![1]
    // Give the OS a moment to tear the job down.
    const deadline = Date.now() + 5000
    let alive = true
    while (Date.now() < deadline && alive) {
      const q = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8' })
      alive = q.stdout.includes(pid)
      if (alive) spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' }) // ~1s sleep
    }
    expect(alive).toBe(false)
  })
})
