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
