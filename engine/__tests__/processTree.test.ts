/**
 * The one place the engine kills a process together with what it started
 * (`engine/processTree.ts`, F210).
 *
 * vitest runs on Node, so `ownProcessTree` is on its fallback here: the tree
 * is found when it is killed. Each test therefore waits until the grandchild
 * is running before it kills, which is the case that fallback handles. The
 * Job Object path, and the case the fallback cannot handle (a tree that is
 * still starting children), is `processTreeJob.test.ts`.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree, ownedExec, overranBuffer, ownProcessTree, OWNED_EXEC_GRACE_MS, type TreeRoot } from '../processTree.js'
import { endMarked, goneWithin, isMarked, newMark } from './helpers/markedProcesses.js'

// Every parent and child of this file carries this mark as an extra argument (F255): what a failing case
// leaves running is ended by the mark, never by a number that may be another process's by then.
const mark = newMark('processtree')
const dirs: string[] = []
afterAll(async () => {
  endMarked(mark)
  await new Promise(r => setTimeout(r, 200))
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/** A pid no process can have: what a kill "of a pid that is gone" is aimed at, so it never reaches a number just freed. */
const NO_SUCH_PID = 2_000_000_000

async function waitFor<T>(read: () => T | undefined | null | false | 0, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(25)
  }
}

/**
 * A parent that starts a child and waits on it; both would run a minute, and both carry the file's mark.
 * Returns the parent as the test holds it and the two pids once the child is up.
 */
async function parentAndChild(): Promise<{ proc: ChildProcess; parent: number; child: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-tree-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'child.js'), `require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000)\n`)
  writeFileSync(join(dir, 'parent.js'), `require('child_process').spawn(process.execPath, ['child.js', process.argv[2]], { stdio: 'ignore' }); setTimeout(() => {}, 60000)\n`)
  const proc = spawn(process.execPath, ['parent.js', mark], { cwd: dir, stdio: 'ignore' })
  const child = await waitFor(() => {
    if (!existsSync(join(dir, 'child.pid'))) return 0
    const n = Number(readFileSync(join(dir, 'child.pid'), 'utf-8'))
    return Number.isInteger(n) && n > 0 ? n : 0
  }, 'the child to start')
  // The evidence `bothGone` rests on: while both run, the mark names both. Without it a mark that named
  // nothing would read as "gone" whatever the kill did (wave 24, check Y2c-5).
  expect(isMarked(proc.pid!, mark), `the parent ${proc.pid} does not carry the mark`).toBe(true)
  expect(isMarked(child, mark), `the child ${child} does not carry the mark`).toBe(true)
  return { proc, parent: proc.pid!, child }
}

/** Both gone: no process has the number, or the one that has it now is not ours (asked by the mark, F255). */
async function bothGone(t: { parent: number; child: number }): Promise<void> {
  expect(await goneWithin(t.parent, mark, 10_000), `the parent ${t.parent} is still running`).toBe(true)
  expect(await goneWithin(t.child, mark, 10_000), `the child ${t.child} is still running`).toBe(true)
}

/** The parent's exit has not been handled: the test still holds it, so its number is nobody else's. */
const stillHeld = (proc: ChildProcess) => { expect(proc.exitCode).toBeNull(); expect(proc.signalCode).toBeNull() }

describe('killProcessTree', () => {
  it('kills the process and the process it started', async () => {
    const tree = await parentAndChild()
    stillHeld(tree.proc)
    await killProcessTree(tree.parent, () => {})
    await bothGone(tree)
  }, 60_000)

  // Changed on purpose in wave 24 (F255): it killed the parent a second time after both were seen gone, by a number
  // that was free from then on. A pid no process can have says the same thing and aims at nobody.
  it('a pid that is already gone is said once and does not throw', async () => {
    const said: string[] = []
    await killProcessTree(NO_SUCH_PID, m => said.push(m))
    if (process.platform === 'win32') {
      expect(said).toHaveLength(1)
      expect(said[0]).toMatch(new RegExp(`^\\[process-tree\\] taskkill /T ${NO_SUCH_PID}: `))
    }
  }, 60_000)
})

describe('ownProcessTree', () => {
  it('kill ends the process and what it started (the started process handed over, as every caller does)', async () => {
    const tree = await parentAndChild()
    const owned = ownProcessTree(tree.proc, () => {})
    await owned.kill()
    await bothGone(tree)
  }, 60_000)

  it('kill ends the process and what it started (a bare number, which behaves as before)', async () => {
    const tree = await parentAndChild()
    stillHeld(tree.proc)
    const owned = ownProcessTree(tree.parent, () => {})
    await owned.kill()
    await bothGone(tree)
  }, 60_000)

  it('release kills nothing: a process that ends on its own leaves what it started running', async () => {
    const tree = await parentAndChild()
    const owned = ownProcessTree(tree.proc, () => {})
    owned.release()
    await sleep(300)
    expect(isMarked(tree.parent, mark)).toBe(true)
    expect(isMarked(tree.child, mark)).toBe(true)
    await ownProcessTree(tree.proc, () => {}).kill()
    await bothGone(tree)
  }, 60_000)

  // Wave 24 (F255): a walked tree is found from its root's number at the kill. Once the runtime has handled the root's
  // exit the number is free, the tree cannot be found from it, and a kill can only land on a stranger.
  it('a root whose exit was handled: the walk starts no taskkill and says once why nothing was killed', async () => {
    for (const ended of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }] as const) {
      const said: string[] = []
      const root: TreeRoot = { pid: NO_SUCH_PID, ...ended }
      const owned = ownProcessTree(root, m => said.push(m))
      expect(owned.kind).toBe('walk')
      await owned.kill()
      await owned.kill()
      expect(said.filter(l => /taskkill/.test(l)), said.join('\n')).toEqual([])
      expect(said.filter(l => !l.includes('no Job Object for child processes'))).toEqual([
        `[process-tree] pid ${NO_SUCH_PID} was not killed: its process has ended and its exit was handled, so the number may be another process's now, and without a Job Object what it started cannot be found from it`,
      ])
    }
  })

  it('a root that ends after it was owned: the same handle refuses from then on', async () => {
    const said: string[] = []
    const root: { pid: number; exitCode: number | null; signalCode: string | null } = { pid: NO_SUCH_PID, exitCode: null, signalCode: null }
    const owned = ownProcessTree(root, m => said.push(m))
    root.exitCode = 1
    await owned.kill()
    expect(said.filter(l => /taskkill/.test(l))).toEqual([])
    expect(said.some(l => l.startsWith(`[process-tree] pid ${NO_SUCH_PID} was not killed: its process has ended`))).toBe(true)
  })

  // Wave 24: the walk's taskkill runs in the same turn of the event loop as its look at the root, while the runtime
  // still holds the root (an asynchronous one is started at once but opens the pid only after it has loaded (100 to
  // 300 ms), and meanwhile the event loop can handle the exit).
  it.skipIf(process.platform !== 'win32')('the walk\'s taskkill has run and answered before kill() returns (Windows)', () => {
    // A root not ended, with a pid no process can have: taskkill runs and answers "not found", and its line is
    // already there when kill() returns. An asynchronous taskkill would answer in a later turn.
    const said: string[] = []
    const owned = ownProcessTree({ pid: NO_SUCH_PID, exitCode: null, signalCode: null }, m => said.push(m))
    void owned.kill()
    expect(said.filter(l => !l.includes('no Job Object for child processes'))).toEqual([
      expect.stringMatching(new RegExp(`^\\[process-tree\\] pid ${NO_SUCH_PID} already gone: `)),
    ])
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('a live root handed over is ended while the runtime still holds it (Windows)', async () => {
    // Renamed in wave 24 (check A-4): an asynchronous taskkill also passes this case, because the synchronous wait
    // below lets it finish; the case before this one is what pins "before kill() returns".
    const tree = await parentAndChild()
    const owned = ownProcessTree(tree.proc, () => {})
    void owned.kill()
    // Still this turn: Node has not handled the exit, so the number is still the test's own child's.
    // taskkill returns once the end is asked for, so the look is repeated for up to a second, without leaving this
    // turn (a synchronous wait), so the runtime cannot handle the exit and free the number meanwhile.
    const pause = new Int32Array(new SharedArrayBuffer(4))
    let running = true
    for (let i = 0; i < 50 && running; i++) {
      try { process.kill(tree.parent, 0) } catch { running = false }
      if (running) Atomics.wait(pause, 0, 0, 20)
    }
    expect(running, 'the root was still running when kill() returned').toBe(false)
    await bothGone(tree)
  }, 60_000)

  it('a spawn that gave no pid has a handle whose kill and release do nothing', async () => {
    const owned = ownProcessTree(undefined)
    await owned.kill()
    owned.release()
    expect(owned.kind).toBe('walk')
  })

  it('outside Bun there is no Job Object: the handle says so and falls back to finding the tree', () => {
    // Node has no bun:ffi. The reason is logged once per process, so it is not asserted here.
    const owned = ownProcessTree(process.pid, () => {})
    expect(owned.kind).toBe('walk')
    owned.release()
  })
})

describe('one helper (F210)', () => {
  /** Every production .ts under engine/, tests and vendored code left out. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) sources(full, out)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
    }
    return out
  }

  it('no file but engine/processTree.ts runs a tree kill of its own', () => {
    const offenders: string[] = []
    for (const file of sources('engine')) {
      const text = readFileSync(file, 'utf-8')
      // A tree kill is `taskkill` with /T, in either order of its switches.
      const treeKill = /taskkill[^\n]*\/T\b/.test(text) || /taskkill[^\n]*'\/T'/.test(text)
      if (treeKill && !file.replace(/\\/g, '/').endsWith('engine/processTree.ts')) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('the callers go through it', () => {
    for (const [file, name] of [
      ['engine/tools/impl/bash.ts', 'ownProcessTree'],
      // Since slice S2 the Git tool runs the repository's own hooks (F242): Stop reaches them too.
      ['engine/tools/impl/git.ts', 'ownProcessTree'],
      ['engine/daemon/taskRunner.ts', 'ownProcessTree'],
      ['engine/brain/jlensSidecar.ts', 'ownProcessTree'],
      ['engine/brain/jlensSidecar.ts', 'killProcessTreeSync'],
      // Wave 19: the four sites that run workspace code without the executor own their child
      // through the one owned exec (its cap, grace and overrun kill were repeated at each).
      ['engine/tools/contractVerify.ts', 'ownedExec'],
      ['engine/bestOfN/sampler.ts', 'ownedExec'],
      ['engine/lsp/manager.ts', 'ownedExec'],
      ['engine/daemon/precheck.ts', 'ownedExec'],
    ] as const) {
      const text = readFileSync(file, 'utf-8')
      expect(text, `${file} must import ${name}`).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[./]+processTree\\.js'`))
      expect(text.split(`${name}(`).length, `${file} must call ${name}`).toBeGreaterThan(1)
    }
  })

  // Wave 24 (F255): a walked tree refuses once its root's exit was handled only when it is handed the started
  // process; a number alone cannot say so. Every production caller hands the process (`ownedExec` hands its child).
  it('every production caller hands ownProcessTree the started process, never its pid', () => {
    for (const [file, call] of [
      ['engine/tools/impl/bash.ts', 'ownProcessTree(child)'],
      ['engine/tools/impl/git.ts', 'ownProcessTree(proc)'],
      ['engine/daemon/taskRunner.ts', 'tree = ownProcessTree(child)'],
      ['engine/daemon/taskRunner.ts', 'ownProcessTree(child, (line) =>'],
      ['engine/apps/desk.ts', 'ownProcessTree(child, () => {})'],
      ['engine/brain/jlensSidecar.ts', 'ownProcessTree(proc, log)'],
      ['scripts/cynco-containment-acceptance.mjs', 'E.T.ownProcessTree(child, (line) =>'],
      ['engine/processTree.ts', 'tree = opts.own(child)'],
    ] as const) {
      const text = readFileSync(file, 'utf-8')
      expect(text, `${file} must call ${call}`).toContain(call)
      expect(text, `${file} hands a pid`).not.toMatch(/ownProcessTree\([A-Za-z_.]*\.pid\b/)
    }
  })

  it('the four owned-exec sites keep no cap, grace or overrun test of their own', () => {
    for (const file of ['engine/tools/contractVerify.ts', 'engine/bestOfN/sampler.ts', 'engine/lsp/manager.ts', 'engine/daemon/precheck.ts']) {
      const text = readFileSync(file, 'utf-8')
      expect(text, file).not.toContain('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      expect(text, file).not.toMatch(/\bsetTimeout\(/)
      expect(text, file).not.toMatch(/\bownProcessTree\(/)
    }
  })
})

/**
 * Wave 19: the owned exec the four harness sites share (a contract check, a best-of-N test run, LSP
 * diagnostics, the daemon precheck), here with a handle that records what is asked of it and a start
 * that answers when told, so each path is shown without a process. The sites' own cases (bypassGrace,
 * bypassTreesJob, runTestsTree, bypassSites) show the same paths with real processes.
 */
describe('ownedExec', () => {
  type Cb = (err: Error | null, stdout: string, stderr: string) => void
  // The pid 4242 is made up and reaches only this recorder: never a real kill, which would name whatever process has
  // that number (F255).
  function harness(kind: 'walk' | 'job' = 'walk') {
    const asked: string[] = []
    let answer: Cb | null = null
    const own = (root: TreeRoot) => {
      asked.push(`own ${root.pid}`)
      return { kind, kill: async () => { asked.push('kill') }, release: () => { asked.push('release') } }
    }
    const start = (cb: Cb) => { answer = cb; asked.push('start'); return { pid: 4242, exitCode: null, signalCode: null } }
    return { asked, own, start, answer: (...a: Parameters<Cb>) => answer!(...a) }
  }

  it('a child that ends on its own gives the handle back and kills nothing', async () => {
    const h = harness()
    const p = ownedExec(h.start, { capMs: 5000, own: h.own })
    h.answer(null, 'out', 'err')
    expect(await p).toEqual({ err: null, stdout: 'out', stderr: 'err', timedOut: false, stopped: false, overran: false })
    expect(h.asked).toEqual(['start', 'own 4242', 'release'])
  })

  it('a failing child is answered as it failed, and its handle is given back', async () => {
    const h = harness()
    const p = ownedExec(h.start, { capMs: 5000, own: h.own })
    const err = Object.assign(new Error('exit 3'), { code: 3 })
    h.answer(err, '', 'boom')
    expect(await p).toMatchObject({ err, stderr: 'boom', timedOut: false, overran: false })
    expect(h.asked).toEqual(['start', 'own 4242', 'release'])
  })

  it('an output overrun (code set, killed unset, as Node and Bun report it) ends the tree held by a Job Object', async () => {
    const h = harness('job')
    const p = ownedExec(h.start, { capMs: 5000, own: h.own })
    h.answer(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'x'.repeat(10), '')
    expect(await p).toMatchObject({ overran: true, timedOut: false, stdout: 'x'.repeat(10) })
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
    expect(overranBuffer({ killed: true })).toBe(true)
    expect(overranBuffer({ code: 1 })).toBe(false)
    expect(overranBuffer(null)).toBe(false)
  })

  // Changed on purpose in wave 24 (F255), was 'kill' for a walked tree too: exec answers after the runtime has handled
  // the root's exit, so a walk could only be aimed at a freed number. As the Bash tool does, a walked tree is released.
  it('an output overrun with a walked tree releases it: the root has ended, and what it started cannot be found from it', async () => {
    const h = harness('walk')
    const p = ownedExec(h.start, { capMs: 5000, own: h.own })
    h.answer(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'x', '')
    expect(await p).toMatchObject({ overran: true, timedOut: false })
    expect(h.asked).toEqual(['start', 'own 4242', 'release'])
  })

  // Wave 24 (F255): the root exited before the cap and a process it started holds the pipes, so exec never answers.
  // The cap asks the real handle to kill; the walk refuses by name; the answer comes after the grace, as cut.
  it('a root that has exited before the cap: the walk refuses at the cap, nothing is killed by its number, the answer comes after the grace', async () => {
    const said: string[] = []
    const child: { pid: number; exitCode: number | null; signalCode: string | null } = { pid: NO_SUCH_PID, exitCode: null, signalCode: null }
    const t0 = Date.now()
    const p = ownedExec(() => child, { capMs: 80, graceMs: 400, own: root => ownProcessTree(root, m => said.push(m)) })
    setTimeout(() => { child.exitCode = 0 }, 20)
    const r = await p
    expect(Date.now() - t0).toBeGreaterThanOrEqual(470)
    expect(r).toEqual({ err: null, stdout: '', stderr: '', timedOut: true, stopped: false, overran: false })
    expect(said.filter(l => /taskkill/.test(l)), said.join('\n')).toEqual([])
    expect(said.filter(l => l.startsWith(`[process-tree] pid ${NO_SUCH_PID} was not killed: its process has ended`))).toHaveLength(1)
  })

  it('the cap ends the tree and the answer is what the child printed when exec answers', async () => {
    const h = harness()
    const cut: string[] = []
    const p = ownedExec(h.start, { capMs: 50, own: h.own, onCut: () => cut.push('cut') })
    await sleep(120)
    expect(cut).toEqual(['cut'])
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
    h.answer(Object.assign(new Error('killed'), { code: 1 }), 'partial', '')
    expect(await p).toMatchObject({ timedOut: true, stopped: false, overran: false, stdout: 'partial' })
    // Nothing more is asked of the handle: the kill was the end of it.
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
  })

  it('after the cap, an exec that never answers is answered after the grace, with nothing printed', async () => {
    const h = harness()
    const t0 = Date.now()
    const r = await ownedExec(h.start, { capMs: 50, graceMs: 150, own: h.own })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    expect(r).toEqual({ err: null, stdout: '', stderr: '', timedOut: true, stopped: false, overran: false })
    expect(OWNED_EXEC_GRACE_MS).toBe(2000)
  })

  it('the signal ends the tree at once, and an answer after the grace is ignored', async () => {
    const h = harness()
    const stop = new AbortController()
    const p = ownedExec(h.start, { capMs: 60_000, graceMs: 100, own: h.own, signal: stop.signal })
    stop.abort()
    const r = await p
    expect(r).toEqual({ err: null, stdout: '', stderr: '', timedOut: false, stopped: true, overran: false })
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
    h.answer(null, 'late', '')
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
  })

  it('a signal already fired ends the child as soon as it is owned', async () => {
    const h = harness()
    const stop = new AbortController()
    stop.abort()
    const p = ownedExec(h.start, { capMs: 60_000, own: h.own, signal: stop.signal })
    h.answer(Object.assign(new Error('killed'), { code: 1 }), '', '')
    expect(await p).toMatchObject({ stopped: true, timedOut: false })
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
  })

  it('a start that throws rejects, and nothing is owned', async () => {
    const asked: string[] = []
    const own = () => { asked.push('own'); return { kind: 'walk' as const, kill: async () => {}, release: () => {} } }
    await expect(ownedExec(() => { throw new Error('refused before anything started') }, { capMs: 50, own })).rejects.toThrow('refused before anything started')
    expect(asked).toEqual([])
  })
})
