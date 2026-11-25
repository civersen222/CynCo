/**
 * A site cut at its cap answers even when the kill reaches nothing (wave 15b, check C4-5).
 *
 * A contract check and LSP diagnostics kill their tree on their own timer and then wait for exec's
 * callback, which comes only when every process holding the pipes has gone. A process the kill could
 * not reach would hold them for ever, so each answers as cut after a two-second grace anyway. No test
 * held a pipe open past the kill, so deleting the grace survived. Here the tree is a handle whose kill
 * does nothing (the one seam: `ownProcessTree`), the command keeps its pipes open, and the answer must
 * still come within the cap and the grace. The test then ends the real tree itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots = vi.hoisted(() => [] as number[])
vi.mock('../../processTree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../processTree.js')>()
  return {
    ...real,
    ownProcessTree: (pid: number | undefined) => {
      if (pid !== undefined) roots.push(pid)
      return { kind: 'walk' as const, kill: async () => {}, release: () => {} }
    },
  }
})

const { killProcessTree } = await import('../../processTree.js')
const { runCommandDetailed } = await import('../../tools/contractVerify.js')
const { LSPManager } = await import('../../lsp/manager.js')
const { runTests } = await import('../../bestOfN/sampler.js')

const dirs: string[] = []
afterEach(async () => {
  for (const pid of roots.splice(0)) await killProcessTree(pid, () => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('a site whose kill reaches nothing still answers after its grace', () => {
  it('a contract check answers timeout within its cap and the two-second grace', async () => {
    const t0 = Date.now()
    const r = await runCommandDetailed(process.cwd(), 'node -e "setInterval(() => {}, 1000)"', 3000)
    const ms = Date.now() - t0
    expect(r.outcome).toBe('timeout')
    expect(ms).toBeGreaterThanOrEqual(4500)
    expect(ms).toBeLessThan(9000)
    expect(roots.length).toBe(1)
  }, 30_000)

  it('LSP diagnostics answer none within their cap and the two-second grace', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cynco-lsp-grace-'))
    dirs.push(d)
    writeFileSync(join(d, 'py_compile.py'), 'import time\ntime.sleep(4000)\n')
    writeFileSync(join(d, 'ok.py'), 'x = 1\n')
    const t0 = Date.now()
    const diags = await new LSPManager(d).getDiagnostics(join(d, 'ok.py'))
    const ms = Date.now() - t0
    expect(diags).toEqual([])
    expect(ms).toBeGreaterThanOrEqual(11_500)
    expect(ms).toBeLessThan(16_000)
    expect(roots.length).toBe(1)
  }, 40_000)

  // Wave 15c (P4(1b), check B4-2): a best-of-N test run is the fourth such site.
  it('a best-of-N test run answers no score within its cap and the two-second grace', async () => {
    const t0 = Date.now()
    const r = await runTests(process.cwd(), { available: true, framework: 'pytest', command: 'node -e "setInterval(() => {}, 1000)"' }, 3000)
    const ms = Date.now() - t0
    expect(r).toEqual({ passed: 0, total: 0, output: '' })
    expect(ms).toBeGreaterThanOrEqual(4500)
    expect(ms).toBeLessThan(9000)
    expect(roots.length).toBe(1)
  }, 30_000)
})
