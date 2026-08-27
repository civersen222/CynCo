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

  // Eval miss (2026-08-27 after-eval): power_row_title's gold file registry.py
  // never surfaced — rowid-ordered references filled all top-k slots from the
  // definition's own file and its test before any other referencing file.
  it('references cover distinct files before repeating one file', () => {
    const s = store()
    s.insertChunk({ filePath: 'gilded/ui/broadsheet.py', chunkType: 'function', name: 'power_row_title',
      startLine: 553, endLine: 560, content: 'def power_row_title(ln): ...', fileHash: 'h' }, [])
    for (let i = 0; i < 3; i++) put(s, `t${i}`, 'assert power_row_title(x)', 'gilded/tests/test_broadsheet.py')
    put(s, 'reg', 'row = power_row_title(ln)', 'gilded/ui/registry.py')
    const refs = lookupSymbol(s, 'power_row_title')!.references
    const firstTwoFiles = refs.slice(0, 2).map(r => r.filePath)
    expect(new Set(firstTwoFiles).size).toBe(2)
    expect(refs.map(r => r.filePath)).toContain('gilded/ui/registry.py')
  })

  it('reference recall reaches past 20 rowid-ordered chunks', () => {
    const s = store()
    s.insertChunk({ filePath: 'def.py', chunkType: 'function', name: 'tick',
      startLine: 1, endLine: 3, content: 'def tick(): pass', fileHash: 'h' }, [])
    for (let i = 0; i < 24; i++) put(s, `f${i}`, 'x = tick()', 'noise/callers.py')
    put(s, 'late', 'y = tick()', 'gilded/registry.py')  // rowid 26 — past the old LIMIT 20
    expect(lookupSymbol(s, 'tick')!.references.map(r => r.filePath)).toContain('gilded/registry.py')
  })

  // Eval misses TREASURY_LABELS and ACCEPT_SCORE: module-level constants have
  // no named chunk, so the symbol leg never fired and keyword rowid order
  // served test files ahead of the defining module.
  it('finds a module-level constant assignment as its definition', () => {
    const s = store()
    put(s, null as any, 'import x\n\nTREASURY_LABELS = {\n  "war": "War chest",\n}', 'gilded/houses.py')
    put(s, 'test_labels', 'from gilded.houses import TREASURY_LABELS\nassert TREASURY_LABELS', 'gilded/tests/test_treasury_journal.py')
    const r = lookupSymbol(s, 'TREASURY_LABELS')!
    expect(r).not.toBeNull()
    expect(r.definitions[0].filePath).toBe('gilded/houses.py')
    expect(r.definitions[0].score).toBe(1.0)
  })

  it('a named definition wins over an assignment-looking chunk', () => {
    const s = store()
    put(s, 'wed_match', 'def wed_match(a, b): ...', 'gilded/society/marriages.py')
    put(s, null as any, 'wed_match = stub()', 'gilded/tests/conftest.py')
    expect(lookupSymbol(s, 'wed_match')!.definitions[0].filePath).toBe('gilded/society/marriages.py')
  })

  it('assignment fallback still returns null for prose queries', () => {
    expect(lookupSymbol(store(), 'overall retrieval architecture notes')).toBeNull()
  })
})

// The 3 remaining CI-only misses of the 2026-08-27 after-eval were ALL
// multi-identifier alternation queries (grep `a\|b`): only the longest
// identifier resolved, so the other symbol's defining file never surfaced.
describe('lookupSymbol — multi-identifier queries', () => {
  it('returns definitions for every resolving identifier, longest first', () => {
    const s = store()
    s.insertChunk({ filePath: 'gilded/ui/broadsheet.py', chunkType: 'function', name: 'power_row_title',
      startLine: 553, endLine: 560, content: 'def power_row_title(ln): ...', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'gilded/ui/registry.py', chunkType: 'function', name: '_accent_counts',
      startLine: 10, endLine: 20, content: 'def _accent_counts(rows): ...', fileHash: 'h' }, [])
    const r = lookupSymbol(s, 'power_row_title _accent_counts')!
    expect(r.symbol).toBe('power_row_title')
    const defFiles = r.definitions.map(d => d.filePath)
    expect(defFiles).toContain('gilded/ui/broadsheet.py')
    expect(defFiles).toContain('gilded/ui/registry.py')
  })

  it('an ambiguous name like __init__ contributes at most 2 defs, best-ranked first', () => {
    const s = store()
    s.insertChunk({ filePath: 'gilded/chassis.py', chunkType: 'class', name: 'GildedGame',
      startLine: 1, endLine: 40, content: 'class GildedGame: ...', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'gilded/chassis.py', chunkType: 'function', name: '__init__',
      startLine: 5, endLine: 20, content: 'def __init__(self, seed): # GildedGame init', fileHash: 'h' }, [])
    for (let i = 0; i < 4; i++) s.insertChunk({ filePath: `noise/${i}.py`, chunkType: 'function', name: '__init__',
      startLine: 1, endLine: 3, content: 'def __init__(self): pass', fileHash: 'h' }, [])
    const r = lookupSymbol(s, 'GildedGame __init__ seed')!
    const initDefs = r.definitions.filter(d => d.name === '__init__')
    expect(initDefs.length).toBeLessThanOrEqual(2)
    expect(initDefs[0].filePath).toBe('gilded/chassis.py')
  })

  it('with no definitions anywhere, the file covering the most identifiers wins', () => {
    // garrison_stub|heir_picker_rows|seed_42.*wars — the gold test file
    // contains ALL the identifiers; every other file contains just one.
    const s = store()
    put(s, 'a', 'x = garrison_stub()', 'gilded/docket.py')
    put(s, 'b', 'rows = heir_picker_rows(h)', 'gilded/ui/house_tab.py')
    put(s, 'c', 'def test_wars():\n    g = garrison_stub()\n    heir_picker_rows(g)\n    seed_42(g)', 'gilded/tests/test_war_verbs_m6b.py')
    const r = lookupSymbol(s, 'garrison_stub heir_picker_rows seed_42 wars')!
    expect(r).not.toBeNull()
    expect(r.definitions.length).toBe(0)
    expect(r.references[0].filePath).toBe('gilded/tests/test_war_verbs_m6b.py')
  })

  // In the live replay, `wars` (from grep `seed_42.*wars`) matched an
  // assignment line in docket.py and hijacked the whole query away from the
  // coverage fallback — the gold file covering 2 of 3 identifiers never ranked.
  it('a plain lowercase word with an assignment does not hijack the query', () => {
    const s = store()
    put(s, 'd', 'wars = totals()', 'gilded/docket.py')
    put(s, 'c', 'def test_garrison_stub_x():\n    seed_42_check()', 'gilded/tests/test_war_verbs_m6b.py')
    put(s, 'h', 'rows = heir_picker_rows(h)', 'gilded/ui/house_tab.py')
    const r = lookupSymbol(s, 'garrison_stub heir_picker_rows seed_42 wars')!
    expect(r).not.toBeNull()
    expect(r.definitions.length).toBe(0)
    expect(r.references[0].filePath).toBe('gilded/tests/test_war_verbs_m6b.py')
  })

  it('an ALL-CAPS name without underscore still resolves via assignment', () => {
    const s = store()
    put(s, null as any, 'BUDGET = 500', 'gilded/houses.py')
    const r = lookupSymbol(s, 'BUDGET')!
    expect(r).not.toBeNull()
    expect(r.definitions[0].filePath).toBe('gilded/houses.py')
  })

  // Live replay: all 50 keyword slots for seed_42 were rowid-ordered chunks of
  // one scratch file, so the gold file never entered the coverage map.
  it('coverage sees a file even when another file hoards the keyword slots', () => {
    const s = store()
    for (let i = 0; i < 60; i++) put(s, `n${i}`, `x = seed_42(${i})`, '.base_broadsheet_test.py')
    put(s, 'g', 'def test_seed_42_wars():\n    garrison_stub()', 'gilded/tests/test_war_verbs_m6b.py')
    const r = lookupSymbol(s, 'garrison_stub seed_42')!
    expect(r).not.toBeNull()
    expect(r.references[0].filePath).toBe('gilded/tests/test_war_verbs_m6b.py')
  })

  it('coverage fallback needs 2+ structural identifiers — prose still returns null', () => {
    const s = store()
    put(s, 'a', 'the game architecture overall', 'gilded/docs.py')
    expect(lookupSymbol(s, 'overall game architecture')).toBeNull()
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
