import { describe, expect, it } from 'bun:test'
import { readTool } from '../../tools/impl/read.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-read-' + Date.now())

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
    rmSync(TMP, { recursive: true, force: true })
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
    rmSync(TMP, { recursive: true, force: true })
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
  const BOM_TMP = join(tmpdir(), 'localcode-test-read-bom-' + Date.now())

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
    rmSync(BOM_TMP, { recursive: true, force: true })
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
    rmSync(BOM_TMP, { recursive: true, force: true })
  })

  it('leaves a file with no byte order mark exactly as it was', async () => {
    // Guard: the fix may only ever act on a mark that is there. Plain UTF-8 is
    // every file in the repo and its handling must not move.
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'plain.txt')
    writeFileSync(path, 'def main():\n    pass\n', 'utf-8')
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.output.startsWith('1\tdef main():')).toBe(true)
    rmSync(BOM_TMP, { recursive: true, force: true })
  })

  it('keeps non-ASCII intact through the BOM strip', async () => {
    mkdirSync(BOM_TMP, { recursive: true })
    const path = join(BOM_TMP, 'accents.txt')
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café — 日本\n', 'utf-8')]))
    const result = await readTool.execute({ file_path: path }, BOM_TMP)
    expect(result.output).toContain('café — 日本')
    rmSync(BOM_TMP, { recursive: true, force: true })
  })
})
