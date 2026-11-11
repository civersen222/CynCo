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
import { killProcessTree, ownProcessTree } from '../processTree.js'

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

  it('the three callers go through it', () => {
    for (const [file, name] of [
      ['engine/tools/impl/bash.ts', 'ownProcessTree'],
      ['engine/daemon/taskRunner.ts', 'ownProcessTree'],
      ['engine/brain/jlensSidecar.ts', 'ownProcessTree'],
      ['engine/brain/jlensSidecar.ts', 'killProcessTreeSync'],
    ] as const) {
      const text = readFileSync(file, 'utf-8')
      expect(text, `${file} must import ${name}`).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[./]+processTree\\.js'`))
      expect(text.split(`${name}(`).length, `${file} must call ${name}`).toBeGreaterThan(1)
    }
  })
})
