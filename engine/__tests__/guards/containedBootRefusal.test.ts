import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { SWITCH_IN_UNATTENDED } from '../../containment.js'

/**
 * F242, entry 6.B1 (a): an unattended engine that cannot adopt the sandbox its starter made does not
 * start. It exits 1 with the named reason BEFORE the model loads, so "declared unattended but not
 * contained" is never a state a tool call can see.
 *
 * The pattern of `oneShotPreflight.test.ts`: the property is the ORDER, so the test asserts that the
 * refusal is printed and that bootstrapProvider()'s own line ("Context budget") is not. Each engine is
 * kept off the live engine's seat: another bridge port, a scratch CYNCO_HOME created first, lazy model
 * (AGENTS.md, Build / test). None of them gets as far as binding anything.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'
const bunPresent = spawnSync(BUN, ['--version'], { encoding: 'utf-8', timeout: 20000 }).status === 0
if (!bunPresent) console.log('[containedBootRefusal] SKIPPED: bun is not on PATH, so the engine entry cannot be started')

function bootEngine(dir: string, env: Record<string, string>, args: string[] = []) {
  const home = join(dir, 'cynco-home')
  mkdirSync(home, { recursive: true })
  const base: Record<string, string | undefined> = { ...process.env }
  // The suite's setup leaves no mission key and no switch; a case adds exactly what it tests.
  for (const k of Object.keys(base)) {
    if (k.startsWith('LOCALCODE_MISSION_') || k === 'LOCALCODE_CONTAINMENT_OFF') delete base[k]
  }
  const r = spawnSync(BUN, ['engine/main.ts', ...args], {
    cwd: REPO, encoding: 'utf-8', timeout: 60000,
    env: {
      ...base,
      CYNCO_HOME: home,
      LOCALCODE_WS_PORT: '19267', // off the phone engine's seat; nothing here binds it
      LOCALCODE_LLAMA_LAZY: 'true',
      LOCALCODE_TRAJECTORY_ENABLED: 'false',
      ...env,
    },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * A usable guard folder with no latch (F242, slice S7): step 2 of the boot block asks it before the
 * sandbox is adopted, so a case that tests a later step hands the engine one. On Windows the temp
 * folder is inside the real home, where a guard folder is refused, so the engine is given a fake home
 * beside it (the CynCo home is named outright by bootEngine).
 */
function clearGuard(dir: string): Record<string, string> {
  const guard = join(dir, 'guard')
  const home = join(dir, 'fake-home')
  mkdirSync(guard, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { LOCALCODE_GUARD_DIR: guard, USERPROFILE: home, HOME: home }
}

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-boot-refusal-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function taskFile(dir: string, extra: Record<string, unknown>): { path: string; outcome: string } {
  const path = join(dir, 'task.json')
  const outcome = join(dir, 'out.json')
  writeFileSync(path, JSON.stringify({
    missionId: 'm', triggerId: 't', prompt: 'p', context: 'c',
    allowedTools: [], timeoutMs: 1000, outcomePath: outcome, ...extra,
  }), 'utf-8')
  return { path, outcome }
}

describe.skipIf(!bunPresent)('a contained boot that cannot adopt its sandbox exits before the model loads', () => {
  it('the switch variable is refused for a mission engine', () => {
    withDir((dir) => {
      const r = bootEngine(dir, { LOCALCODE_MISSION_MARKER: 'm', LOCALCODE_CONTAINMENT_OFF: 'paths' })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain(`[containment] refused: containment: ${SWITCH_IN_UNATTENDED}`)
      expect(r.out).toContain('[engine] REFUSED: containment:')
      expect(r.out).not.toContain('Context budget')
    })
  }, 70000)

  it('a mission engine with no run id is refused', () => {
    withDir((dir) => {
      const r = bootEngine(dir, { LOCALCODE_MISSION_MARKER: 'm', LOCALCODE_MISSION_CWD: dir, ...clearGuard(dir) })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('[containment] refused: containment: no run id was handed to this engine (LOCALCODE_MISSION_RUN_ID is unset or malformed)')
      expect(r.out).not.toContain('Context budget')
    })
  }, 70000)

  it('a one-shot whose task file names no sandbox is refused, and its outcome file says so', () => {
    withDir((dir) => {
      const t = taskFile(dir, { cwd: dir })
      const r = bootEngine(dir, clearGuard(dir), ['--run-task', t.path])
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('[containment] refused: containment: the task file names no sandbox (runId)')
      expect(r.out).toContain('[one-shot] REFUSED: containment:')
      expect(r.out).not.toContain('Context budget')
      expect(existsSync(t.outcome)).toBe(true)
      const outcome = JSON.parse(readFileSync(t.outcome, 'utf-8'))
      expect(outcome.ok).toBe(false)
      expect(String(outcome.error)).toMatch(/^REFUSED: containment: /)
    })
  }, 70000)

  it('a one-shot whose task file names no cwd is refused before its run id is asked for', () => {
    withDir((dir) => {
      const t = taskFile(dir, {})
      const r = bootEngine(dir, clearGuard(dir), ['--run-task', t.path])
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain("[containment] refused: containment: this task names no cwd, so it would work in the engine's own checkout")
      expect(r.out).toContain('give the mission a cwd')
      expect(r.out).not.toContain('Context budget')
    })
  }, 70000)

  // F242, slice S7, step 2: no usable guard folder, or a latch in it, refuses the boot before the sandbox
  // is adopted and before the model loads.
  it('step 2: a guard folder that does not exist refuses a mission engine as integrity, before the adopt', () => {
    withDir((dir) => {
      const missing = join(dir, 'no-such-guard')
      const r = bootEngine(dir, { LOCALCODE_MISSION_MARKER: 'm', LOCALCODE_MISSION_CWD: dir, LOCALCODE_GUARD_DIR: missing })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain(`[containment] refused: integrity: the guard folder ${missing} does not exist (LOCALCODE_GUARD_DIR is set to ${missing})`)
      expect(r.out).toContain('[engine] REFUSED: integrity:')
      expect(r.out).not.toContain('no run id was handed to this engine')
      expect(r.out).not.toContain('Context budget')
    })
  }, 70000)

  it('step 2: the integrity latch refuses a one-shot, and its outcome file says REFUSED: integrity', () => {
    withDir((dir) => {
      const env = clearGuard(dir)
      writeFileSync(join(env.LOCALCODE_GUARD_DIR!, 'HALT.json'), JSON.stringify({ schema: 1, at: '2026-11-23T00:00:00.000Z', by: 'test', publicSummary: '1 change(s) in protected folders (first: PRESENCE)', run: 'test-run' }))
      const t = taskFile(dir, { cwd: dir })
      const r = bootEngine(dir, env, ['--run-task', t.path])
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('[containment] refused: integrity: the integrity latch is present at ')
      expect(r.out).toContain('(1 change(s) in protected folders (first: PRESENCE), set 2026-11-23T00:00:00.000Z by test); only the owner clears it, at a terminal, with: bun scripts/cynco-guard.mjs clear')
      expect(r.out).not.toContain('Context budget')
      const outcome = JSON.parse(readFileSync(t.outcome, 'utf-8'))
      expect(String(outcome.error)).toMatch(/^REFUSED: integrity: the integrity latch is present at /)
    })
  }, 70000)
})