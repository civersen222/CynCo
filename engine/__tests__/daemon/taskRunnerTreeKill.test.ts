/**
 * engine/daemon/taskRunner.ts `killTree`, Windows: a one-shot ended mid-run is ended with what it started, not the
 * child alone (F210). The stub engine of taskRunner.test.ts starts nothing, so `child.kill()` by itself passed every
 * case there and the tree's own kill (`await tree.kill()`) was pinned by none (wave 24, round three, check Y2c-4).
 *
 * The run is ended by the integrity latch (`halted`), the same `killTree` the timeout and the pause go through, once a
 * watcher has seen the grandchild: no timer races the start. The stand-in engine is written by this test into its temp
 * folder; its grandchild carries a mark, and is asked about and, should a case fail, ended only by the mark (F255,
 * `helpers/markedProcesses.ts`). It ends by itself after a minute either way.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRunner } from '../../daemon/taskRunner.js'
import { ActivityRegistry } from '../../power/activity.js'
import { endMarked, goneWithin, newMark, watchMarked, type MarkWatch } from '../helpers/markedProcesses.js'

const marks: string[] = [], watches: MarkWatch[] = [], dirs: string[] = []
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop().catch(() => undefined)
  for (const m of marks.splice(0)) endMarked(m)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

/** The pid the stand-in wrote, once the file holds a whole positive number (it can exist before it is written). */
async function pidWritten(file: string, ms: number): Promise<number> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file)) {
      const n = Number(readFileSync(file, 'utf-8').trim())
      if (Number.isInteger(n) && n > 0) return n
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`the stand-in engine wrote no pid to ${file} within ${ms} ms`)
}

describe('TaskRunner: a one-shot ended mid-run is ended with what it started (F210, check Y2c-4)', () => {
  it.skipIf(process.platform !== 'win32')('the grandchild the one-shot started is gone after the stop, not the one-shot alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-trtree-'))
    dirs.push(dir)
    const mark = newMark('taskRunnerTree')
    marks.push(mark)
    const pidFile = join(dir, 'grandchild.pid')
    const stub = join(dir, 'standIn.mjs')
    // The mark is in the grandchild's program text only: not in the stand-in's command line, not in the folder's name.
    // `detached`: a grandchild this Node stand-in started without it ended with the stand-in whatever `killTree` did
    // (measured: with `stdio` alone the case passed with the tree's kill taken out; why was not measured). The real
    // one-shot runs under Bun; whether a Bun root's children end with it was not measured here either, so the
    // stand-in starts its grandchild detached, which a walk of the stand-in's tree still finds.
    writeFileSync(stub, [
      `import { spawn } from 'node:child_process'`,
      `import { writeFileSync } from 'node:fs'`,
      `const g = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => {}, 60000) // ${mark}`)}], { stdio: 'ignore', detached: true, windowsHide: true })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
      `setTimeout(() => {}, 60000)`,
      '',
    ].join('\n'))
    const w = watchMarked(mark)
    watches.push(w)
    await w.ready
    let seen = false
    const runner = new TaskRunner({
      workDir: dir, spawnCmd: [process.execPath, stub], isGpuBusyImpl: async () => false,
      gpuBusyPath: join(dir, 'gpu-busy.json'), activity: new ActivityRegistry(), deadWaitMs: 5000,
      pausePollMs: 100, halted: () => (seen ? 'the test ends the run now' : null),
    })
    const running = runner.run({ missionId: 'm1', triggerId: 't1', prompt: 'x', context: 'ctx', allowedTools: ['Mfl'], timeoutMs: 30_000, outcomePath: join(dir, 'out.json') })
    const pid = await pidWritten(pidFile, 15_000)
    expect(await w.saw(pid, 15_000), `the grandchild ${pid} was never seen carrying its mark while it ran`).toBe(true)
    seen = true
    const outcome = await running
    expect(outcome.error).toBe('STOPPED: integrity: the test ends the run now')
    // child.kill() alone ends the stand-in and leaves this running for its minute.
    expect(await goneWithin(pid, mark, 10_000), `the grandchild ${pid} outlived the kill of the one-shot`).toBe(true)
    expect(await w.stop()).toContain(pid)
  }, 60_000)
})
