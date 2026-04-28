import { describe, expect, it } from 'bun:test'
import { lsTool } from '../../tools/impl/ls.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'lc-ls-' + Date.now())

describe('Ls tool', () => {
  it('lists files in a directory', async () => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'foo.ts'), 'const x = 1')
    writeFileSync(join(TMP, 'bar.ts'), 'const y = 2')

    const result = await lsTool.execute({ path: TMP }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('foo.ts')
    expect(result.output).toContain('bar.ts')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('lists subdirectories recursively', async () => {
    const dir = join(tmpdir(), 'lc-ls-rec-' + Date.now())
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'nested.ts'), 'hi')

    const result = await lsTool.execute({ path: dir, recursive: true }, dir)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('sub/')
    expect(result.output).toContain('nested.ts')
    rmSync(dir, { recursive: true, force: true })
  })

  it('has correct metadata', () => {
    expect(lsTool.name).toBe('Ls')
    expect(lsTool.tier).toBe('auto')
  })

  it('returns error for non-existent directory', async () => {
    const result = await lsTool.execute({ path: '/nonexistent/path/xyz' }, process.cwd())
    expect(result.isError).toBe(true)
  })
})
