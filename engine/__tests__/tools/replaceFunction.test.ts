import { describe, expect, it } from 'bun:test'
import { replaceFunctionTool } from '../../tools/impl/replaceFunction.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function scratch(name: string, content: string): { dir: string; file: string } {
  const dir = join(tmpdir(), `lc-replacefn-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  return { dir, file }
}

describe('ReplaceFunction — python', () => {
  it('replaces the named function body', async () => {
    const { dir, file } = scratch('a.py', 'def one():\n    return 1\n\n\ndef two():\n    return 2\n')
    const result = await replaceFunctionTool.execute(
      { file_path: file, function_name: 'one', new_body: 'def one():\n    return 111' },
      dir,
    )
    expect(result.isError).toBe(false)
    const out = readFileSync(file, 'utf-8')
    expect(out).toContain('return 111')
    expect(out).not.toContain('return 1\n')
    expect(out).toContain('def two():')
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves the blank lines separating it from the next function', async () => {
    // PEP 8 wants two blank lines between top-level defs. Those blanks sit
    // *after* the body, so a tool that treats them as part of the function
    // deletes them on every single call.
    const { dir, file } = scratch('b.py', 'def one():\n    return 1\n\n\ndef two():\n    return 2\n')
    await replaceFunctionTool.execute(
      { file_path: file, function_name: 'one', new_body: 'def one():\n    return 111' },
      dir,
    )
    expect(readFileSync(file, 'utf-8')).toBe('def one():\n    return 111\n\n\ndef two():\n    return 2\n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not eat a comment that belongs to the next function', async () => {
    // Silent deletion of neighbouring source is the worst outcome here: the
    // model is told the replace succeeded and never learns it lost a line.
    const { dir, file } = scratch(
      'c.py',
      'def one():\n    return 1\n\n\n# ---- section: helpers ----\ndef two():\n    return 2\n',
    )
    await replaceFunctionTool.execute(
      { file_path: file, function_name: 'one', new_body: 'def one():\n    return 111' },
      dir,
    )
    expect(readFileSync(file, 'utf-8')).toContain('# ---- section: helpers ----')
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps comments and blank lines that are inside the body out of the way', async () => {
    const { dir, file } = scratch(
      'd.py',
      'def one():\n    a = 1\n\n    # midway\n    return a\n\n\ndef two():\n    return 2\n',
    )
    await replaceFunctionTool.execute(
      { file_path: file, function_name: 'one', new_body: 'def one():\n    return 111' },
      dir,
    )
    const out = readFileSync(file, 'utf-8')
    expect(out).not.toContain('# midway')
    expect(out).toBe('def one():\n    return 111\n\n\ndef two():\n    return 2\n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('replaces the last function in a file without trailing damage', async () => {
    const { dir, file } = scratch('e.py', 'def one():\n    return 1\n\n\ndef two():\n    return 2\n')
    await replaceFunctionTool.execute(
      { file_path: file, function_name: 'two', new_body: 'def two():\n    return 222' },
      dir,
    )
    expect(readFileSync(file, 'utf-8')).toBe('def one():\n    return 1\n\n\ndef two():\n    return 222\n')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports an error when the function is not there', async () => {
    const { dir, file } = scratch('f.py', 'def one():\n    return 1\n')
    const result = await replaceFunctionTool.execute(
      { file_path: file, function_name: 'nope', new_body: 'def nope():\n    pass' },
      dir,
    )
    expect(result.isError).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
