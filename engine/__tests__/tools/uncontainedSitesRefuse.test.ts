/**
 * F242: in a contained run, the spawn sites that do not yet start their child through the
 * containment (the Git tool, ApplyPatch, the contract's command check and its git reads) refuse
 * instead of running at medium integrity in the mission folder, where a hook, a git setting or a
 * test file the run wrote would be executed. Outside a contained run they behave as before.
 *
 * Works only inside its own mkdtemp folder; the context is a test context (nothing on disk).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refusalLayerOf, setRunContainment, testContainment } from '../../containment.js'
import { gitTool } from '../../tools/impl/git.js'
import { applyPatchTool } from '../../tools/impl/applyPatch.js'
import { gitProbe, runCommandDetailed } from '../../tools/contractVerify.js'

let dir: string

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cynco-uncontained-')))
})

afterEach(() => {
  setRunContainment(null)
  rmSync(dir, { recursive: true, force: true })
})

function contain(): void {
  const runDir = join(dir, 'run')
  setRunContainment(testContainment({
    missionCwd: dir,
    sandbox: { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') },
    home: join(dir, 'home'),
    folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
  }))
}

// A command that leaves a file behind if it runs at all.
const WITNESS = 'ran.txt'
const writeWitness = `node -e "require('fs').writeFileSync('${WITNESS}', 'x')"`

describe('spawn sites not yet contained, in a contained run', () => {
  it('the Git tool refuses by name and starts nothing', async () => {
    contain()
    const r = await gitTool.execute({ subcommand: 'status' }, dir)
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('containment')
    expect(r.output).toContain('the Git tool is not contained in an unattended run yet')
  })

  it('ApplyPatch refuses by name', async () => {
    contain()
    const r = await applyPatchTool.execute({ patch: 'not a patch\n', check: true }, dir)
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('containment')
    expect(r.output).toContain('ApplyPatch is not contained in an unattended run yet')
  })

  it('a contract check command is no answer, says why, and is not run', async () => {
    contain()
    const r = await runCommandDetailed(dir, writeWitness, 30_000)
    expect(r.outcome).toBe('unrunnable')
    expect(refusalLayerOf(r.tail)).toBe('containment')
    expect(r.tail).toContain('a contract check command is not contained in an unattended run yet')
    expect(existsSync(join(dir, WITNESS))).toBe(false)
  })

  it('the contract\'s git reads answer "cannot tell" (null) without running git', async () => {
    contain()
    const probe = gitProbe(dir)
    expect(await probe.head()).toBeNull()
    expect(await probe.dirtyPaths()).toBeNull()
  })
})

describe('the same sites with no contained run', () => {
  it('a contract check command runs as before', async () => {
    const r = await runCommandDetailed(dir, writeWitness, 60_000)
    expect(r.outcome, r.tail).toBe('passed')
    expect(existsSync(join(dir, WITNESS))).toBe(true)
  }, 90_000)

  it('ApplyPatch reaches git apply as before', async () => {
    const r = await applyPatchTool.execute({ patch: 'not a patch\n', check: true }, dir)
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBeNull()
  })
})
