// Wave 19b (from package B's list): Bun never fetches a package by itself. A Bun start that runs a file
// whose folder has no installed packages above it would otherwise install a missing import from the
// registry on the fly (measured: `--no-install` makes such an import a plain "Cannot find package" error,
// exit 1). Every Bun start in these three scripts carries `--no-install`, read from the source text.
// Text only, so it holds on every platform.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

describe('the Bun starts of the ideation one-shot, the code-index evaluation and the vibe end-to-end run carry --no-install', () => {
  it('cynco-ideation.mjs: the one-shot engine', () => {
    const s = src('cynco-ideation.mjs')
    expect(s).toContain("spawn('bun', ['--no-install', resolve(repoRoot, 'engine', 'main.ts'), '--run-task', taskPath]")
    expect(s.match(/spawn\('bun', \[(?!'--no-install')/g)).toBeNull()
  })

  it('codeindex-eval.mjs: the worker', () => {
    const s = src('codeindex-eval.mjs')
    expect(s).toContain("execFileSync('bun', ['--no-install', 'run', join(ROOT, 'scripts', 'codeindex-eval-worker.ts')")
    expect(s.match(/\('bun', \[(?!'--no-install')/g)).toBeNull()
  })

  it('vibe-e2e.ts: the engine it drives', () => {
    const s = src('vibe-e2e.ts')
    expect(s).toContain("Bun.spawn(['bun', '--no-install', join(repoRoot, 'engine', 'main.ts')]")
    expect(s.match(/\['bun', (?!'--no-install')/g)).toBeNull()
  })
})
