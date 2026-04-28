import { describe, expect, it } from 'bun:test'
const SKIP_ENV = !process.env.CYNCO_INTEGRATION
import { grepTool } from '../../tools/impl/grep.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-grep-' + Date.now())

describe('Grep tool', () => {
  it('has correct metadata', () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.tier).toBe('auto')
  })

  it.skipIf(SKIP_ENV)('finds content matches', async () => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'a.ts'), 'function hello() {}\nfunction world() {}')
    writeFileSync(join(TMP, 'b.ts'), 'const x = 1')
    const result = await grepTool.execute({ pattern: 'function', path: TMP }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
    expect(result.output).toContain('world')
    rmSync(TMP, { recursive: true, force: true })
  })
})
