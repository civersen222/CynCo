import { describe, expect, it } from 'bun:test'
import { globTool } from '../../tools/impl/glob.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-glob-' + Date.now())

describe('Glob tool', () => {
  it('has correct metadata', () => {
    expect(globTool.name).toBe('Glob')
    expect(globTool.tier).toBe('auto')
  })

  it('finds files by pattern', async () => {
    mkdirSync(join(TMP, 'sub'), { recursive: true })
    writeFileSync(join(TMP, 'a.ts'), 'x')
    writeFileSync(join(TMP, 'b.ts'), 'x')
    writeFileSync(join(TMP, 'c.txt'), 'x')
    writeFileSync(join(TMP, 'sub', 'd.ts'), 'x')
    const result = await globTool.execute({ pattern: '**/*.ts', path: TMP }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
    expect(result.output).toContain('d.ts')
    expect(result.output).not.toContain('c.txt')
    rmSync(TMP, { recursive: true, force: true })
  })
})
