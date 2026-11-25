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
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree, ownedExec, overranBuffer, ownProcessTree, OWNED_EXEC_GRACE_MS } from '../processTree.js'

const dirs: string[] = []
const pids: number[] = []
afterAll(async () => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  await new Promise(r => setTimeout(r, 200))
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitFor<T>(read: () => T | undefined | null | false | 0, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(25)
  }
}

/** A parent that starts a child and waits on it; both would run a minute. Returns their pids once the child is up. */
async function parentAndChild(): Promise<{ parent: number; child: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-tree-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'child.js'), `require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000)\n`)
  writeFileSync(join(dir, 'parent.js'), `require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)\n`)
  const proc = spawn(process.execPath, ['parent.js'], { cwd: dir, stdio: 'ignore' })
  const child = await waitFor(() => {
    if (!existsSync(join(dir, 'child.pid'))) return 0
    const n = Number(readFileSync(join(dir, 'child.pid'), 'utf-8'))
    return Number.isInteger(n) && n > 0 ? n : 0
  }, 'the child to start')
  pids.push(proc.pid!, child)
  return { parent: proc.pid!, child }
}

const bothGone = (t: { parent: number; child: number }) =>
  waitFor(() => !alive(t.parent) && !alive(t.child), 'the parent and its child to be gone', 10_000)

describe('killProcessTree', () => {
  it('kills the process and the process it started', async () => {
    const tree = await parentAndChild()
    await killProcessTree(tree.parent, () => {})
    await bothGone(tree)
  }, 60_000)

  it('a pid that is already gone is said once and does not throw', async () => {
    const tree = await parentAndChild()
    await killProcessTree(tree.parent, () => {})
    await bothGone(tree)
    const said: string[] = []
    await killProcessTree(tree.parent, m => said.push(m))
    if (process.platform === 'win32') expect(said.join('\n')).toMatch(/taskkill \/T/)
  }, 60_000)
})

describe('ownProcessTree', () => {
  it('kill ends the process and what it started', async () => {
    const tree = await parentAndChild()
    const owned = ownProcessTree(tree.parent, () => {})
    await owned.kill()
    await bothGone(tree)
  }, 60_000)

  it('release kills nothing: a process that ends on its own leaves what it started running', async () => {
    const tree = await parentAndChild()
    const owned = ownProcessTree(tree.parent, () => {})
    owned.release()
    await sleep(300)
    expect(alive(tree.parent)).toBe(true)
    expect(alive(tree.child)).toBe(true)
    await killProcessTree(tree.parent, () => {})
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
  function harness() {
    const asked: string[] = []
    let answer: Cb | null = null
    const own = (pid: number | undefined) => {
      asked.push(`own ${pid}`)
      return { kind: 'walk' as const, kill: async () => { asked.push('kill') }, release: () => { asked.push('release') } }
    }
    const start = (cb: Cb) => { answer = cb; asked.push('start'); return { pid: 4242 } }
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

  it('an output overrun (code set, killed unset, as Node and Bun report it) ends the tree', async () => {
    const h = harness()
    const p = ownedExec(h.start, { capMs: 5000, own: h.own })
    h.answer(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'x'.repeat(10), '')
    expect(await p).toMatchObject({ overran: true, timedOut: false, stdout: 'x'.repeat(10) })
    expect(h.asked).toEqual(['start', 'own 4242', 'kill'])
    expect(overranBuffer({ killed: true })).toBe(true)
    expect(overranBuffer({ code: 1 })).toBe(false)
    expect(overranBuffer(null)).toBe(false)
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
