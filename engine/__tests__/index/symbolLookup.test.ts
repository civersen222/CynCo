import { describe, it, expect } from 'bun:test'
import { extractIdentifiers, lookupSymbol, formatDefinitionCard } from '../../index/symbolLookup.js'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function store(): IndexStore {
  return new IndexStore(join(mkdtempSync(join(tmpdir(), 'ci-sym-')), 'p.db'))
}

const put = (s: IndexStore, name: string, content: string, file = `x/${name}.py`) => s.insertChunk({
  filePath: file, chunkType: 'function', name, startLine: 1, endLine: 5,
  content, fileHash: 'h',
}, [])

describe('extractIdentifiers', () => {
  it('finds snake_case and drops query filler words', () => {
    expect(extractIdentifiers('_gen_betrothal_offer function body'))
      .toEqual(['_gen_betrothal_offer'])
  })

  it('finds camelCase', () => {
    expect(extractIdentifiers('where is powerRowTitle used')).toEqual(['powerRowTitle'])
  })

  it('keeps plain words >=3 chars that are not stopwords, longest first', () => {
    expect(extractIdentifiers('the ambitions ladder')).toEqual(['ambitions', 'ladder'])
  })

  it('drops stopwords and short tokens entirely', () => {
    expect(extractIdentifiers('what is the def of a')).toEqual([])
  })

  it('dunder counts as identifier', () => {
    expect(extractIdentifiers('__init__ of Spy')).toEqual(['__init__', 'Spy'])
  })
})

describe('lookupSymbol', () => {
  it('burned query 1: "_gen_betrothal_offer function body" returns the definition, not Spy', () => {
    const s = store()
    put(s, 'Spy', 'class Spy:\n    def function_table(self): pass') // the old wrong answer
    s.insertChunk({ filePath: 'gilded/marriage.py', chunkType: 'function', name: '_gen_betrothal_offer',
      startLine: 40, endLine: 62, content: 'def _gen_betrothal_offer(state):\n    ...', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'gilded/events.py', chunkType: 'function', name: 'accept_offer',
      startLine: 10, endLine: 20, content: 'offer = _gen_betrothal_offer(s)', fileHash: 'h' }, [])
    const r = lookupSymbol(s, '_gen_betrothal_offer function body')!
    expect(r).not.toBeNull()
    expect(r.symbol).toBe('_gen_betrothal_offer')
    expect(r.definitions[0].filePath).toBe('gilded/marriage.py')
    expect(r.references.map(x => x.filePath)).toEqual(['gilded/events.py']) // def chunk excluded
  })

  it('returns null when no identifier resolves', () => {
    expect(lookupSymbol(store(), 'overall game architecture')).toBeNull()
  })

  it('longest identifier wins over a shorter colliding one', () => {
    const s = store()
    put(s, 'name', 'def name(): pass')
    s.insertChunk({ filePath: 'a.py', chunkType: 'function', name: 'power_row_title',
      startLine: 1, endLine: 3, content: 'def power_row_title(ln): ...', fileHash: 'h' }, [])
    expect(lookupSymbol(s, 'power_row_title name')!.symbol).toBe('power_row_title')
  })

  it('multiple same-name defs ranked by remaining query terms', () => {
    const s = store()
    s.insertChunk({ filePath: 'a.py', chunkType: 'function', name: 'render',
      startLine: 1, endLine: 3, content: 'def render(map): draw the atlas', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'b.py', chunkType: 'function', name: 'render',
      startLine: 1, endLine: 3, content: 'def render(card): draw a dossier card', fileHash: 'h' }, [])
    const r = lookupSymbol(s, 'render dossier card')!
    expect(r.definitions[0].filePath).toBe('b.py')
  })

  it('caps references at 10', () => {
    const s = store()
    s.insertChunk({ filePath: 'def.py', chunkType: 'function', name: 'tick',
      startLine: 1, endLine: 3, content: 'def tick(): pass', fileHash: 'h' }, [])
    for (let i = 0; i < 15; i++) put(s, `caller${i}`, 'x = tick()', `c/${i}.py`)
    expect(lookupSymbol(s, 'tick')!.references.length).toBeLessThanOrEqual(10)
  })
})

describe('formatDefinitionCard', () => {
  it('emits the card shape from the spec', () => {
    const card = formatDefinitionCard({
      symbol: '_bank_debt_lever',
      definitions: [{ filePath: 'gilded/orders.py', name: '_bank_debt_lever', chunkType: 'function',
        startLine: 78, endLine: 96, content: 'def _bank_debt_lever():\n    pass', score: 1.0 }],
      references: [{ filePath: 'gilded/chassis.py', name: null as any, chunkType: 'block',
        startLine: 436, endLine: 440, content: 'x = _bank_debt_lever()\nmore', score: 0.5 }],
    })
    expect(card).toContain('=== DEFINITION gilded/orders.py:78-96 (function _bank_debt_lever) ===')
    expect(card).toContain('def _bank_debt_lever():')
    expect(card).toContain('=== REFERENCES (1) ===')
    expect(card).toContain('gilded/chassis.py:436-440  x = _bank_debt_lever()')
  })
})
