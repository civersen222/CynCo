import { afterAll, describe, expect, it } from 'bun:test'
import { readTool } from '../../tools/impl/read.js'
import { globTool } from '../../tools/impl/glob.js'
import { lsTool } from '../../tools/impl/ls.js'
import { ALL_TOOLS, getCoreTools } from '../../tools/registry.js'
import { PROJECT_TOOL_NAMES } from '../../projects/profile.js'
import { gradeProjectCall } from '../../projects/binding.js'
import { writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-read-' + Date.now())
const BOM_TMP = join(tmpdir(), 'localcode-test-read-bom-' + Date.now())
const DIR_TMP = join(tmpdir(), 'localcode-test-read-dir-' + Date.now())

// Every temp folder goes once the file is done, a failed test included: a
// cleanup at the end of a test body never runs when an expect before it throws.
afterAll(() => {
  for (const dir of [TMP, BOM_TMP, DIR_TMP]) rmSync(dir, { recursive: true, force: true })
})

describe('Read tool', () => {
  it('has correct metadata', () => {
    expect(readTool.name).toBe('Read')
    expect(readTool.tier).toBe('auto')
    expect(readTool.inputSchema.properties).toHaveProperty('file_path')
  })

  it('reads a text file', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'hello.txt')
    writeFileSync(path, 'line 1\nline 2\nline 3\n')
    const result = await readTool.execute({ file_path: path }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('line 1')
    expect(result.output).toContain('line 2')
  })

  it('returns error for non-existent file', async () => {
    const result = await readTool.execute({ file_path: '/no/such/file.txt' }, '/')
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
  })

  it('respects offset and limit', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'lines.txt')
    writeFileSync(path, 'a\nb\nc\nd\ne\n')
    const result = await readTool.execute({ file_path: path, offset: 2, limit: 2 }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('b')
    expect(result.output).toContain('c')
    expect(result.output).not.toContain('d')
  })
})

/**
 * Finding (ab). Read decoded every file as UTF-8 whatever byte order mark it
 * carried, so a file the agent had just produced with `... > out.txt` came back
 * as `h\0e\0l\0l\0o\0` — text that names nothing, from a file the agent wrote
 * itself. Measured: on this machine `>` under Windows PowerShell 5.1 emits
 * `ff fe` UTF-16LE (task-19db3979 recorded exactly such a file, `test_output.txt`,
 * which git classified as binary and the run eventually deleted).
 *
 * A byte order mark is not content. Reading it as content is the tool telling
 * the model something about the file that is not true.
 */
describe('Read tool — byte order marks are decoding, not content', () => {
  it('does not report a UTF-8 BOM as the first character of line 1', async () => {
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'utf8bom.txt')
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('import os\nimport sys\n', 'utf-8')]))
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.isError).toBe(false)
    // The point of the test: `1\timport os`, not `1\t\ufeffimport os`. A model
    // matching on a line start — and every grep-like habit it has does — misses
    // the first line of the file otherwise.
    expect(result.output.startsWith('1\timport os')).toBe(true)
    expect(result.output).not.toContain('\ufeff')
  })

  it('decodes a UTF-16LE file as text rather than returning NUL-interleaved mojibake', async () => {
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'utf16le.txt')
    // Byte-for-byte what PowerShell 5.1 `'line 1' > f; 'line 2' >> f` produces.
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('line 1\r\nline 2\r\n', 'utf16le')]))
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('line 1')
    expect(result.output).toContain('line 2')
    expect(result.output).not.toContain('\u0000')
  })

  it('leaves a file with no byte order mark exactly as it was', async () => {
    // Guard: the fix may only ever act on a mark that is there. Plain UTF-8 is
    // every file in the repo and its handling must not move.
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'plain.txt')
    writeFileSync(path, 'def main():\n    pass\n', 'utf-8')
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.output.startsWith('1\tdef main():')).toBe(true)
  })

  it('keeps non-ASCII intact through the BOM strip', async () => {
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'accents.txt')
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café — 日本\n', 'utf-8')]))
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.output).toContain('café — 日本')
  })
})

/**
 * F178 (its open item). Read's answer for a folder said "Use Glob or Bash ls".
 * In a project chat that points at the shell — the path F178 closed, where
 * the chat read its prompt files through Bash `Get-Content`. The answer names
 * only file tools every session is offered (a project chat's
 * PROJECT_TOOL_NAMES and a coding session's core set), the project grader
 * lets each call it spells out through, and each one really lists the folder
 * — with its path as `path`, not inside a pattern, so a folder whose name
 * holds glob characters ("[2]") lists too.
 *
 * The folder here holds only a subfolder. Bun's Glob yields files only
 * (`scan`'s onlyFiles defaults to true), so the round-1 advice, pattern "*",
 * listed nothing for such a folder under the real runtime: a dead end. The
 * test shim (setup/bunShim.ts, fs.globSync) yields folders too, so the Glob
 * answer is judged here by its files, as Bun gives it.
 */
describe('Read tool — a folder is answered with the file tools, never the shell', () => {
  /** The lines of a Glob answer that name a file — what Bun's Glob answers. */
  const filesOnly = (output: string, dir: string) => output.split('\n')
    .filter(l => { try { return statSync(join(dir, l)).isFile() } catch { return false } })
    .map(l => l.split(sep).join('/'))
  const grade = (toolName: string, input: Record<string, unknown>) => gradeProjectCall(DIR_TMP, DIR_TMP, () => 'safe', () => '', toolName, input)

  for (const folder of ['designs', 'take [2] {draft}']) {
    it(`names Ls, Glob and Read for a folder holding only a subfolder; the Ls and Glob calls it spells out are safe in a project and name what is inside (${JSON.stringify(folder)})`, async () => {
      const dir = join(DIR_TMP, folder)
      mkdirSync(join(dir, 'tower-a'), { recursive: true })
      writeFileSync(join(dir, 'tower-a', 'd1-gallery.txt'), 'the gallery tower, three storeys\n')
      const result = await readTool.execute({ file_path: dir }, DIR_TMP)
      expect(result.isError).toBe(true)
      expect(result.output).toBe(`Error: ${dir} is a directory, not a file. List it with Ls (path "${dir}") or Glob (path "${dir}", pattern "**/*"), then Read a file it shows by its full path (the folder joined with the path it shows).`)
      const words = result.output.split(dir).join('<folder>') // the advice, without the path's own words
      expect(words).not.toMatch(/Bash|Get-Content|PowerShell|shell/i)
      expect(words).not.toMatch(/\b(ls|cat|dir|type)\b/) // the shell's commands, lower case; the tool is Ls
      // Every tool the answer names is one a project chat and a coding session both have.
      const named = ALL_TOOLS.map(t => t.name).filter(n => new RegExp('(^|[^A-Za-z])' + n + '([^A-Za-z]|$)').test(words)).sort()
      expect(named).toEqual(['Glob', 'Ls', 'Read'])
      const core = new Set(getCoreTools().map(t => t.name))
      for (const n of named) {
        expect(PROJECT_TOOL_NAMES).toContain(n)
        expect(core.has(n)).toBe(true)
      }
      const m = /List it with Ls \(path "(.*?)"\) or Glob \(path "(.*?)", pattern "(.*?)"\), then Read /.exec(result.output)
      expect(m).not.toBeNull()
      const [, lsPath, globPath, pattern] = m!
      // A project chat's grader lets both calls through: an absolute path inside the project is safe.
      expect(grade('Ls', { path: lsPath })).toEqual({ level: 'safe', reason: '' })
      // ...and Ls is graded as a file tool: the same call outside the project is refused.
      expect(grade('Ls', { path: join(DIR_TMP, '..') }).level).toBe('dangerous')
      expect(grade('Glob', { path: globPath, pattern })).toEqual({ level: 'safe', reason: '' })
      // Ls, as spelled out, names the subfolder.
      expect(await lsTool.execute({ path: lsPath }, DIR_TMP)).toEqual({ output: 'tower-a/', isError: false })
      // Glob, as spelled out, names the file inside it — by its files alone, as
      // Bun answers. Pattern "*" (the round-1 advice) names nothing here.
      const globbed = await globTool.execute({ path: globPath, pattern }, DIR_TMP)
      expect(globbed.isError).toBe(false)
      expect(filesOnly(globbed.output, globPath)).toEqual(['tower-a/d1-gallery.txt'])
      expect(filesOnly((await globTool.execute({ path: globPath, pattern: '*' }, DIR_TMP)).output, globPath)).toEqual([])
      // And Read reads the file Glob showed, by its full path: the folder joined with the
      // path Glob printed (relative to the folder, not to the session's working folder).
      const shown = filesOnly(globbed.output, globPath)[0]
      const file = join(globPath, shown)
      expect(grade('Read', { file_path: file })).toEqual({ level: 'safe', reason: '' })
      expect(await readTool.execute({ file_path: file }, DIR_TMP)).toEqual({ output: '1\tthe gallery tower, three storeys\n2\t', isError: false })
    })
  }
})
