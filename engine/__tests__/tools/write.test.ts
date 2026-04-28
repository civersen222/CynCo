import { describe, expect, it } from 'bun:test'
import { writeTool } from '../../tools/impl/write.js'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-write-' + Date.now())

describe('Write tool', () => {
  it('has correct metadata', () => {
    expect(writeTool.name).toBe('Write')
    expect(writeTool.tier).toBe('approval')
  })

  it('creates a new file', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'new.ts')
    const result = await writeTool.execute({ file_path: path, content: 'hello world' }, TMP)
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('hello world')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('creates parent directories', async () => {
    const path = join(TMP, 'deep', 'nested', 'file.ts')
    const result = await writeTool.execute({ file_path: path, content: 'nested' }, TMP)
    expect(result.isError).toBe(false)
    expect(existsSync(path)).toBe(true)
    rmSync(TMP, { recursive: true, force: true })
  })
})
