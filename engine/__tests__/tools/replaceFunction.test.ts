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

// Two classes, each with a method of the same name. This is the ordinary shape
// of a codebase, not a corner case, and it is where picking the first match
// silently edits the wrong function and reports success.
const TWO_CLASSES =
  'class Scheme:\n' +
  '    def advance(self):\n' +
  '        return "scheme"\n' +
  '\n' +
  '\n' +
  'class Takeover:\n' +
  '    def advance(self):\n' +
  '        return "takeover"\n'

describe('ReplaceFunction — naming a method that appears in more than one class', () => {
  it('honours the class in a qualified name instead of taking the first match', async () => {
    const { dir, file } = scratch('g.py', TWO_CLASSES)
    const result = await replaceFunctionTool.execute(
      {
        file_path: file,
        function_name: 'Takeover.advance',
        new_body: '    def advance(self):\n        return "replaced"',
      },
      dir,
    )
    expect(result.isError).toBe(false)
    const out = readFileSync(file, 'utf-8')
    expect(out).toContain('return "scheme"')
    expect(out).toContain('return "replaced"')
    expect(out).not.toContain('return "takeover"')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a bare name that matches more than one method, and says where they are', async () => {
    // Guessing here is worse than failing: the model is told it succeeded and
    // never learns it destroyed a function it never named.
    const { dir, file } = scratch('h.py', TWO_CLASSES)
    const result = await replaceFunctionTool.execute(
      { file_path: file, function_name: 'advance', new_body: '    def advance(self):\n        return "x"' },
      dir,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Scheme.advance')
    expect(result.output).toContain('Takeover.advance')
    expect(readFileSync(file, 'utf-8')).toBe(TWO_CLASSES)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports an error when the class in a qualified name has no such method', async () => {
    const { dir, file } = scratch('i.py', TWO_CLASSES)
    const result = await replaceFunctionTool.execute(
      { file_path: file, function_name: 'Bribe.advance', new_body: '    def advance(self):\n        pass' },
      dir,
    )
    expect(result.isError).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(TWO_CLASSES)
    rmSync(dir, { recursive: true, force: true })
  })

  it('still replaces a bare name that is unambiguous', async () => {
    const { dir, file } = scratch('j.py', TWO_CLASSES + '\n\ndef settle():\n    return 0\n')
    const result = await replaceFunctionTool.execute(
      { file_path: file, function_name: 'settle', new_body: 'def settle():\n    return 9' },
      dir,
    )
    expect(result.isError).toBe(false)
    expect(readFileSync(file, 'utf-8')).toContain('return 9')
    rmSync(dir, { recursive: true, force: true })
  })
})
