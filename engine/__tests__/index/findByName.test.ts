import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function freshStore(): IndexStore {
  return new IndexStore(join(mkdtempSync(join(tmpdir(), 'ci-name-')), 'p.db'))
}

const chunk = (name: string, file = 'gilded/orders.py') => ({
  filePath: file, chunkType: 'function', name, startLine: 10, endLine: 20,
  content: `def ${name}():\n    pass`, fileHash: 'h',
})

describe('IndexStore.findByName', () => {
  it('exact match wins', () => {
    const s = freshStore()
    s.insertChunk(chunk('_bank_debt_lever'), [])
    s.insertChunk(chunk('other'), [])
    const hits = s.findByName('_bank_debt_lever', true)
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('_bank_debt_lever')
    expect(hits[0].score).toBe(1.0)
    expect(hits[0].filePath).toBe('gilded/orders.py')
    expect(hits[0].startLine).toBe(10)
  })

  it('falls back to case-insensitive when exact pass empty', () => {
    const s = freshStore()
    s.insertChunk(chunk('PowerRowTitle'), [])
    expect(s.findByName('powerrowtitle', true)).toHaveLength(1)
  })

  it('caseSensitive=false skips the fallback pass', () => {
    const s = freshStore()
    s.insertChunk(chunk('PowerRowTitle'), [])
    expect(s.findByName('powerrowtitle', false)).toHaveLength(0)
  })

  it('empty for unknown name', () => {
    expect(freshStore().findByName('nope', true)).toHaveLength(0)
  })

  it('returns all same-name definitions', () => {
    const s = freshStore()
    s.insertChunk(chunk('render', 'a.py'), [])
    s.insertChunk(chunk('render', 'b.py'), [])
    expect(s.findByName('render', true)).toHaveLength(2)
  })
})
