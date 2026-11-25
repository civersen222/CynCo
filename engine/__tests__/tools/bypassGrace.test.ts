/**
 * A site cut at its cap answers even when the kill reaches nothing (wave 15b, check C4-5).
 *
 * A contract check and LSP diagnostics kill their tree on their own timer and then wait for exec's
 * callback, which comes only when every process holding the pipes has gone. A process the kill could
 * not reach would hold them for ever, so each answers as cut after a two-second grace anyway. No test
 * held a pipe open past the kill, so deleting the grace survived. Here the tree is a handle whose kill
 * does nothing (the one seam: `ownProcessTree`), the command keeps its pipes open, and the answer must
 * still come within the cap and the grace. The test then ends what it started by the mark each command
 * carries in its command line (`helpers/markedProcesses.ts`), never by the root's pid (F255, wave 24): the
 * programs are still running then, which each case shows first, and the mark finds them whatever the root did.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endMarked, marked, newMark, noneMarkedWithin } from '../helpers/markedProcesses.js'

const roots = vi.hoisted(() => [] as number[])
vi.mock('../../processTree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../processTree.js')>()
  return {
    ...real,
    // Wave 24: a site hands the started process (a `TreeRoot`), or a pid as before; either is taken.
    ownProcessTree: (root: unknown) => {
      const pid = typeof root === 'object' && root !== null ? (root as { pid?: number }).pid : root as number | undefined
      if (pid !== undefined) roots.push(pid)
      return { kind: 'walk' as const, kill: async () => {}, release: () => {} }
    },
  }
})

const { runCommandDetailed } = await import('../../tools/contractVerify.js')
const { LSPManager } = await import('../../lsp/manager.js')
const { runTests } = await import('../../bestOfN/sampler.js')

const dirs: string[] = []
const marks: string[] = []
const newCaseMark = (label: string) => { const m = newMark(label); marks.push(m); return m }
afterEach(() => {
  // What a failing case left is ended by its mark; a passing case has ended it already.
  for (const m of marks.splice(0)) endMarked(m)
  roots.splice(0)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

/** The kill reached nothing, so what the command started still runs: found by its mark, then ended by it. */
async function stillRunningThenEnd(mark: string): Promise<void> {
  expect(marked(mark).length, 'nothing that carries the mark runs after the answer: the case cannot show a kill that reached nothing').toBeGreaterThan(0)
  endMarked(mark)
  expect(await noneMarkedWithin(mark), 'a program that carries the mark still runs after it was ended by it').toBe(true)
}

describe('a site whose kill reaches nothing still answers after its grace', () => {
  it('a contract check answers timeout within its cap and the two-second grace', async () => {
    const mark = newCaseMark('graceContract')
    const t0 = Date.now()
    // The program waits a minute: it holds the pipes past the cap and the grace, and ends by itself if all else fails.
    const r = await runCommandDetailed(process.cwd(), `node -e "setTimeout(() => {}, 60000) // ${mark}"`, 3000)
    const ms = Date.now() - t0
    expect(r.outcome).toBe('timeout')
    expect(ms).toBeGreaterThanOrEqual(4500)
    expect(ms).toBeLessThan(9000)
    expect(roots.length).toBe(1)
    await stillRunningThenEnd(mark)
  }, 30_000)

  it('LSP diagnostics answer none within their cap and the two-second grace', async () => {
    const mark = newCaseMark('graceLsp')
    const d = mkdtempSync(join(tmpdir(), 'cynco-lsp-grace-'))
    dirs.push(d)
    // `python -m py_compile <file>` carries no comment: the mark is in the name of the file it is handed.
    writeFileSync(join(d, 'py_compile.py'), 'import time\ntime.sleep(60)\n')
    const file = join(d, `ok_${mark}.py`)
    writeFileSync(file, 'x = 1\n')
    const t0 = Date.now()
    const diags = await new LSPManager(d).getDiagnostics(file)
    const ms = Date.now() - t0
    expect(diags).toEqual([])
    expect(ms).toBeGreaterThanOrEqual(11_500)
    expect(ms).toBeLessThan(16_000)
    expect(roots.length).toBe(1)
    await stillRunningThenEnd(mark)
  }, 40_000)

  // Wave 15c (P4(1b), check B4-2): a best-of-N test run is the fourth such site.
  it('a best-of-N test run answers no score within its cap and the two-second grace', async () => {
    const mark = newCaseMark('graceBestOfN')
    const t0 = Date.now()
    const r = await runTests(process.cwd(), { available: true, framework: 'pytest', command: `node -e "setTimeout(() => {}, 60000) // ${mark}"` }, 3000)
    const ms = Date.now() - t0
    expect(r).toEqual({ passed: 0, total: 0, output: '' })
    expect(ms).toBeGreaterThanOrEqual(4500)
    expect(ms).toBeLessThan(9000)
    expect(roots.length).toBe(1)
    await stillRunningThenEnd(mark)
  }, 30_000)
})
