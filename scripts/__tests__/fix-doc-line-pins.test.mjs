// scripts/__tests__/fix-doc-line-pins.test.mjs
import { describe, expect, it } from 'vitest'
import { rewritePins, choosePinLine, splitBaselined } from '../fix-doc-line-pins.mjs'

describe('rewritePins (one pass, never re-scans its own output)', () => {
  it('two pins on one line each move once: 12->19 is not caught again by 19->25', () => {
    const map = new Map([['store.ts:12', 19], ['store.ts:19', 25]])
    expect(rewritePins('(`store.ts:12`, `store.ts:19`)', map)).toBe('(`store.ts:19`, `store.ts:25`)')
  })

  it('a range maps both ends, and moves the unmapped end by the same delta', () => {
    expect(rewritePins('`learningStore.ts:232-240`', new Map([['learningStore.ts:232', 244], ['learningStore.ts:240', 252]]))).toBe('`learningStore.ts:244-252`')
    expect(rewritePins('`learningStore.ts:232-240`', new Map([['learningStore.ts:232', 244]]))).toBe('`learningStore.ts:244-252`')
  })

  it('leaves longer numbers, other files and path-prefixed names alone', () => {
    const map = new Map([['store.ts:12', 19]])
    expect(rewritePins('store.ts:120 mystore.ts:12 index/store.ts:12 other.ts:12', map)).toBe('store.ts:120 mystore.ts:12 index/store.ts:12 other.ts:12')
  })

  it('a full-path key matches the full-path token', () => {
    const map = new Map([['engine/bridge/conversationLoop.ts:1255', 1263]])
    expect(rewritePins('(`engine/bridge/conversationLoop.ts:1255`)', map)).toBe('(`engine/bridge/conversationLoop.ts:1263`)')
  })
})

/** A file of `n` blank lines with the given 1-based lines filled in. */
function fileWith(n, filled) {
  const lines = Array.from({ length: n }, () => '')
  for (const [line, text] of Object.entries(filled)) lines[Number(line) - 1] = text
  return lines
}

describe('choosePinLine (the definition first, the nearest use only when there is none)', () => {
  // 2026-11-11: 44 lines came out of engine/tools/impl/bash.ts and the fixer sent the doc's
  // pin for bashMaxTimeoutMs from 139 to 148, a use, where the definition sits at 95.
  it('the bash.ts case: a use nearer the old pin does not beat the definition', () => {
    const lines = fileWith(170, {
      95: 'export function bashMaxTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {',
      128: '    const cap = bashMaxTimeoutMs()',
      148: '      timeout: Math.min(requested, bashMaxTimeoutMs()),',
      162: '  return `capped at ${bashMaxTimeoutMs()} ms`',
    })
    expect(choosePinLine(lines, 'bashMaxTimeoutMs', 139)).toBe(95)
  })

  it('an exported definition beats a local one of the same name', () => {
    const lines = fileWith(60, { 10: '  const limit = 5', 40: 'export const limit = 9' })
    expect(choosePinLine(lines, 'limit', 12)).toBe(40)
  })

  it('a class member is a definition: a modifier before the name, or a body after the signature', () => {
    const lines = fileWith(90, {
      20: '    await this.ensureRunningLazy(deps)',
      50: '  async ensureRunningLazy(deps: LazyWaitDeps): Promise<void> {',
      70: '  private cannotStop = false',
      80: '    if (this.cannotStop) return',
    })
    expect(choosePinLine(lines, 'ensureRunningLazy', 22)).toBe(50)
    expect(choosePinLine(lines, 'cannotStop', 79)).toBe(70)
  })

  it('two definitions of one name: the one nearer the old pin', () => {
    const lines = fileWith(100, { 10: 'export function open(a: string): void', 80: 'export function open(a: string, b: number): void {' })
    expect(choosePinLine(lines, 'open', 70)).toBe(80)
    expect(choosePinLine(lines, 'open', 20)).toBe(10)
  })

  it('no definition in the file: the nearest occurrence, as before', () => {
    const lines = fileWith(50, { 5: "import { helper } from './helper.js'", 30: '  helper(1)', 44: '  helper(2)' })
    expect(choosePinLine(lines, 'helper', 40)).toBe(44)
  })

  it('a longer name that contains the symbol is not the symbol', () => {
    const lines = fileWith(40, { 10: 'export function openAll(): void {', 30: 'export function open(): void {' })
    expect(choosePinLine(lines, 'open', 11)).toBe(30)
  })

  it('a symbol that is nowhere in the file has no line', () => {
    expect(choosePinLine(fileWith(10, { 3: 'export const other = 1' }), 'gone', 3)).toBeNull()
  })
})

describe('splitBaselined (a ref the guard already allows is reported, never moved)', () => {
  it('keeps the baselined refs out of the work and names them', () => {
    const refs = ['a/CLAUDE.md: one @ x.ts:10', 'a/CLAUDE.md: two @ x.ts:20', 'b/CLAUDE.md: three @ y.ts:30']
    const baseline = ['a/CLAUDE.md: two @ x.ts:20', 'c/CLAUDE.md: elsewhere @ z.ts:1']
    expect(splitBaselined(refs, baseline)).toEqual({
      todo: ['a/CLAUDE.md: one @ x.ts:10', 'b/CLAUDE.md: three @ y.ts:30'],
      skipped: ['a/CLAUDE.md: two @ x.ts:20'],
    })
  })
})

describe('choosePinLine reads a name literally, whatever characters it has', () => {
  it('a name with a dollar sign is that name, not a pattern', () => {
    const lines = fileWith(20, { 4: 'const xstate = 2', 9: 'export const $state = 1', 15: '  use($state)' })
    expect(choosePinLine(lines, '$state', 1)).toBe(9)
  })

  it('pattern characters in a name match themselves only', () => {
    const lines = fileWith(12, { 3: 'export const aXb = 1', 8: 'const x = table[a.b]' })
    expect(choosePinLine(lines, 'a.b', 1)).toBe(8)
    expect(choosePinLine(lines, 'a\b', 1)).toBeNull()
  })
})
