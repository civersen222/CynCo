import { describe, expect, it } from 'bun:test'
import { editTool } from '../../tools/impl/edit.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-edit-' + Date.now())

describe('Edit tool', () => {
  it('has correct metadata', () => {
    expect(editTool.name).toBe('Edit')
    expect(editTool.tier).toBe('approval')
  })

  it('replaces a string in a file', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'edit.ts')
    writeFileSync(path, 'const x = "old"\nconst y = 2\n')
    const result = await editTool.execute({
      file_path: path, old_string: 'const x = "old"', new_string: 'const x = "new"',
    }, TMP)
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('const x = "new"\nconst y = 2\n')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('errors when old_string not found', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'edit2.ts')
    writeFileSync(path, 'hello world')
    const result = await editTool.execute({
      file_path: path, old_string: 'no match', new_string: 'replacement',
    }, TMP)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('errors when old_string matches multiple times without replace_all', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'edit3.ts')
    writeFileSync(path, 'aaa\naaa\n')
    const result = await editTool.execute({
      file_path: path, old_string: 'aaa', new_string: 'bbb',
    }, TMP)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not unique')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('replaces all when replace_all is true', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'edit4.ts')
    writeFileSync(path, 'aaa\naaa\n')
    const result = await editTool.execute({
      file_path: path, old_string: 'aaa', new_string: 'bbb', replace_all: true,
    }, TMP)
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('bbb\nbbb\n')
    rmSync(TMP, { recursive: true, force: true })
  })
})
