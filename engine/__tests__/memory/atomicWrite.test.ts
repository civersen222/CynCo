import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileAtomic } from '../../memory/atomicWrite.js'

describe('writeFileAtomic', () => {
  let dir: string
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('writes content that is fully readable after return', () => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'out.json')
    writeFileAtomic(target, '{"a":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}')
  })

  it('overwrites an existing file atomically (no leftover temp files)', () => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'out.json')
    writeFileAtomic(target, 'first')
    writeFileAtomic(target, 'second')
    expect(readFileSync(target, 'utf-8')).toBe('second')
    // No .tmp-* siblings left behind
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })

  it('accepts a Buffer payload', () => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'blob.bin')
    writeFileAtomic(target, Buffer.from([1, 2, 3]))
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
  })
})
