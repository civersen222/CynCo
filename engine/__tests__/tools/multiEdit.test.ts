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

  // Measured on three consecutive civkings waves (I4c1a runs 1-3): every
  // multi-line MultiEdit against a CRLF file failed with `old_string not
  // found`, and the same anchors then applied cleanly through Edit. Edit
  // normalises CRLF before matching; MultiEdit did not. Single-line anchors
  // hid the bug because they contain no newline.
  it('matches a multi-line old_string in a CRLF file', async () => {
    const dir = join(tmpdir(), 'lc-me-crlf-' + Date.now())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'crlf.py')
    writeFileSync(file, 'def f():\r\n    return 11\r\n\r\ndef g():\r\n    return 2\r\n')

    const result = await multiEditTool.execute({
      edits: [
        { file_path: file, old_string: 'def f():\n    return 11', new_string: 'def f():\n    return 12' },
      ],
    }, dir)

    expect(result.output).not.toContain('old_string not found')
    expect(result.isError).toBe(false)
    const after = readFileSync(file, 'utf-8')
    expect(after).toContain('return 12')
    // The file was CRLF and must stay CRLF, including on the rewritten lines.
    expect(after).toBe('def f():\r\n    return 12\r\n\r\ndef g():\r\n    return 2\r\n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not convert an LF file to CRLF', async () => {
    const dir = join(tmpdir(), 'lc-me-lf-' + Date.now())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'lf.py')
    writeFileSync(file, 'def f():\n    return 11\n')

    const result = await multiEditTool.execute({
      edits: [
        { file_path: file, old_string: 'def f():\n    return 11', new_string: 'def f():\n    return 12' },
      ],
    }, dir)

    expect(result.isError).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe('def f():\n    return 12\n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('quotes the near-miss window when a multi-line anchor does not match', async () => {
    const dir = join(tmpdir(), 'lc-me-near-' + Date.now())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'near.py')
    writeFileSync(file, 'def uniquely_named_thing():\r\n    return 11\r\n')

    const result = await multiEditTool.execute({
      edits: [
        { file_path: file, old_string: 'def uniquely_named_thing():\n    return 99', new_string: 'x' },
      ],
    }, dir)

    expect(result.isError).toBe(true)
    // Not just "not found" — the engine has the answer in hand and must say it.
    expect(result.output).toContain('return 11')
    rmSync(dir, { recursive: true, force: true })
  })

  it('has correct metadata', () => {
    expect(multiEditTool.name).toBe('MultiEdit')
    expect(multiEditTool.tier).toBe('approval')
  })
})
