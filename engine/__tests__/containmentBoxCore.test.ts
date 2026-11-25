/**
 * The box-core changes of 2026-11-24 read live, under Bun on Windows (fixtures/boxCore.ts): the real
 * low-integrity launcher, real labels, the real probe. vitest's Node has no bun:ffi, so the fixture
 * runs in a `bun` child started directly (never through a shell, so a timeout ends bun itself: F210),
 * and this file reads its one JSON line. The pure halves are in `containment.test.ts`
 * (containedPathValue, toolEnv, the release's calls) and `lowIntegrityLauncherShell.test.ts`.
 *
 * The fixture works only inside the folder this test makes with mkdtemp; this test removes it with a
 * walk that never enters a link.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listEntries } from '../realPath.js'

const PREFIX = 'cynco-boxcore-'
const FIXTURE = fileURLToPath(new URL('./fixtures/boxCore.ts', import.meta.url))

/** Remove the folder this test made, never entering a link (its kind from the folder's listing, F4). */
function removeOwnTree(dir: string): void {
  const abs = resolve(dir)
  if (dirname(abs) !== resolve(tmpdir()) || !basename(abs).startsWith(PREFIX)) throw new Error(`refusing to remove ${abs}: not a ${PREFIX}* folder directly in the temp folder`)
  const walk = (d: string) => {
    for (const { name, kind } of listEntries(d)) {
      const p = join(d, name)
      if (kind === 'link') {
        try { rmdirSync(p) } catch { unlinkSync(p) }
      } else if (kind === 'dir') {
        walk(p)
        rmdirSync(p)
      } else {
        unlinkSync(p)
      }
    }
  }
  walk(abs)
  rmdirSync(abs)
}

const onWindows = process.platform === 'win32'
function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}
const bunExe = onWindows ? findBunExe() : null
if (onWindows && bunExe === null) console.log('[containmentBoxCore] SKIPPED: bun is not on PATH (or did not name its executable within 15 s), so the Windows layer was not exercised')

const made: string[] = []
afterAll(() => { for (const d of made) removeOwnTree(d) })

type Report = { ok: boolean; error?: string; isolation?: string; cases: Record<string, any> }

describe.skipIf(!onWindows || bunExe === null)('the box core under Bun on Windows (fixtures/boxCore.ts)', () => {
  let report: Report | null = null
  const get = (): Report => {
    if (report) return report
    const dir = mkdtempSync(join(tmpdir(), PREFIX))
    made.push(dir)
    const env = { ...process.env }
    delete env.LOCALCODE_CONTAINMENT_OFF
    // P2-F11: the fixture by its own path, not one relative to the folder vitest was started in.
    const run = spawnSync(bunExe!, [FIXTURE, dir], { encoding: 'utf-8', windowsHide: true, timeout: 180_000, env })
    const last = String(run.stdout ?? '').trim().split('\n').pop() ?? ''
    try {
      report = JSON.parse(last) as Report
    } catch (e) {
      throw new Error(`the fixture printed no report (status ${run.status}, ${(e as Error).message}):\n${run.stdout}\n${run.stderr}`)
    }
    if (!report.ok) throw new Error(`the fixture could not start: ${report.error}\n${run.stdout}\n${run.stderr}`)
    console.log(`[containmentBoxCore] isolation ${report.isolation}; release: ${JSON.stringify(report.cases.releaseNote)}`)
    return report
  }
  const ok = (name: string) => {
    const v = get().cases[name]
    expect(v, `case ${name} did not report`).toBeDefined()
    expect(v.threw, `case ${name} threw`).toBeUndefined()
    return v
  }

  it('the probe passed (the launcher really lowered the child)', () => {
    expect(get().isolation).toBe('verified')
  })

  // NOW.md:261: before, the launcher started PowerShell through `shell:`, which hands it `-c <command>` alone.
  it('NOW.md:261: a contained PowerShell is started with -NoProfile -NonInteractive -Command', () => {
    const v = ok('noProfile')
    expect(v.err).toBeNull()
    expect(v.commandLine).toMatch(/powershell\.exe"? -NoProfile -NonInteractive -Command /i)
    expect(v.commandLine).not.toMatch(/powershell\.exe"? -c /i)
  }, 240_000)

  // NOW.md:96, and R1 F2 as the lead decided it in wave 15b (P2-F5): the PATH reorder made a bare
  // `bash` start System32\bash.exe, the WSL launcher, so it is out; the child's PATH is the one it was
  // given, and a bare whoami under Git's usr\bin is Git's copy (the msys hint names the way round).
  it('P2-F5: the contained child\'s PATH is the one it was given (no reorder): under Git\'s usr\\bin first a bare whoami is Git\'s; OneDrive* name the sandbox home', () => {
    const v = ok('pathOrder')
    expect(v.err).toBeNull()
    expect(String(v.said.path).toLowerCase()).toBe(String(v.given).toLowerCase())
    if (v.gitUsr) {
      expect(String(v.said.whoami).toLowerCase()).toBe('c:\\program files\\git\\usr\\bin\\whoami.exe')
      expect(String(v.said.grep).toLowerCase()).toBe('c:\\program files\\git\\usr\\bin\\grep.exe')
    } else {
      console.log('[containmentBoxCore] Git\'s usr\\bin\\grep.exe is not on this PC: the whoami and grep halves were not read')
    }
    expect(v.said.onedrive).toBe(join(v.sandboxHome, 'OneDrive'))
    expect(v.said.onedriveconsumer).toBe(join(v.sandboxHome, 'OneDrive'))
  }, 240_000)

  // NOW.md:78: before, a released sandbox stayed labelled low until the seven-day sweep.
  it('NOW.md:78: after the release the sandbox\'s home, tmp and scratch read medium, and a low child can no longer create a file there', () => {
    const before = ok('lowWritesBeforeRelease')
    expect(before.said).toBe('created')
    expect(before.labels.join(' ')).toMatch(/Low Mandatory Level/)
    const note = get().cases.releaseNote
    expect(note.relabelled, note.note).toBe(true)
    expect(note.note).toContain("the sandbox's home, tmp and scratch set back to medium integrity (")
    const v = ok('release')
    expect(v.anyLow, JSON.stringify(v.labels)).toBe(false)
    expect(v.said).toBe('denied')
    expect(v.exists).toBe(false)
  }, 240_000)
})
