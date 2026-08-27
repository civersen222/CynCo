import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function store(): IndexStore {
  return new IndexStore(join(mkdtempSync(join(tmpdir(), 'ci-kw-')), 'p.db'))
}

const put = (s: IndexStore, name: string, content: string) => s.insertChunk({
  filePath: `x/${name}.py`, chunkType: 'function', name, startLine: 1, endLine: 5,
  content, fileHash: 'h',
}, [])

describe('demoted keywordSearch', () => {
  it('no longer serves a chunk that merely contains a common word (the Spy bug)', () => {
    const s = store()
    put(s, 'Spy', 'class Spy:\n    def function_table(self): pass')
    // old behavior: OR over ["_gen_betrothal_offer","function","body"] matched Spy via "function"
    expect(s.keywordSearch('_gen_betrothal_offer function body')).toHaveLength(0)
  })

  it('requires ALL identifier-like terms', () => {
    const s = store()
    put(s, 'a', 'betrothal_offer accept_handler here')
    put(s, 'b', 'betrothal_offer only')
    const hits = s.keywordSearch('betrothal_offer accept_handler')
    expect(hits.map(h => h.name)).toEqual(['a'])
  })

  it('single identifier still matches content (reference finding)', () => {
    const s = store()
    put(s, 'caller', 'x = _bank_debt_lever()')
    expect(s.keywordSearch('_bank_debt_lever')).toHaveLength(1)
  })

  it('all-stopword query returns nothing instead of everything', () => {
    const s = store()
    put(s, 'anything', 'the function of this code')
    expect(s.keywordSearch('what is the function')).toHaveLength(0)
  })
})
