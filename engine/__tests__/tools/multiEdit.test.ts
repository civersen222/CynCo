import { describe, expect, it } from 'bun:test'
import { multiEditTool } from '../../tools/impl/multiEdit.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'lc-multiedit-' + Date.now())

describe('MultiEdit tool', () => {
  it('applies multiple edits to different files', async () => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'a.ts'), 'const x = 1\nconst y = 2\n')
    writeFileSync(join(TMP, 'b.ts'), 'const z = 3\n')

    const result = await multiEditTool.execute({
      edits: [
        { file_path: join(TMP, 'a.ts'), old_string: 'const x = 1', new_string: 'const x = 10' },
        { file_path: join(TMP, 'b.ts'), old_string: 'const z = 3', new_string: 'const z = 30' },
      ],
    }, TMP)

    expect(result.isError).toBe(false)
    expect(readFileSync(join(TMP, 'a.ts'), 'utf-8')).toContain('x = 10')
    expect(readFileSync(join(TMP, 'b.ts'), 'utf-8')).toContain('z = 30')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('fails gracefully when file not found', async () => {
    const result = await multiEditTool.execute({
      edits: [
        { file_path: '/nonexistent/file.ts', old_string: 'x', new_string: 'y' },
      ],
    }, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('FAIL')
  })

  it('fails when old_string not found', async () => {
    const dir = join(tmpdir(), 'lc-me-notfound-' + Date.now())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'c.ts'), 'const x = 1\n')
    const result = await multiEditTool.execute({
      edits: [{ file_path: join(dir, 'c.ts'), old_string: 'not here', new_string: 'replaced' }],
    }, dir)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('FAIL')
    rmSync(dir, { recursive: true, force: true })
  })

  it('has correct metadata', () => {
    expect(multiEditTool.name).toBe('MultiEdit')
    expect(multiEditTool.tier).toBe('approval')
  })
})
