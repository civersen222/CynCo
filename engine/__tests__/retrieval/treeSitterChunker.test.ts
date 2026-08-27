import { describe, expect, it } from 'bun:test'
import { treeSitterChunk } from '../../retrieval/treeSitterChunker.js'

// ─── TypeScript ───────────────────────────────────────────────────────────────

describe('treeSitterChunker — TypeScript', () => {
  it('extracts a named function declaration', async () => {
    const code = `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
`
    const chunks = await treeSitterChunk('greet.ts', code)
    expect(chunks).not.toBeNull()
    const fn = chunks!.find(c => c.chunkType === 'function')
    expect(fn).toBeDefined()
    expect(fn!.name).toBe('greet')
    expect(fn!.startLine).toBeGreaterThanOrEqual(1)
    expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine)
  })

  it('extracts a TypeScript class', async () => {
    const code = `export class Greeter {
  private name: string
  constructor(name: string) {
    this.name = name
  }
  greet(): string {
    return \`Hello, \${this.name}!\`
  }
}
`
    const chunks = await treeSitterChunk('greeter.ts', code)
    expect(chunks).not.toBeNull()
    const cls = chunks!.find(c => c.chunkType === 'class')
    expect(cls).toBeDefined()
    expect(cls!.name).toBe('Greeter')
  })

  it('extracts an import block', async () => {
    const code = `import { foo } from './foo.js'
import type { Bar } from './bar.js'

export function doThing() {
  return foo()
}
`
    const chunks = await treeSitterChunk('thing.ts', code)
    expect(chunks).not.toBeNull()
    const imp = chunks!.find(c => c.chunkType === 'import_block')
    expect(imp).toBeDefined()
    expect(imp!.content).toContain("from './foo.js'")
  })

  it('extracts relationships from import block', async () => {
    const code = `import { alpha } from './alpha.js'
import { beta } from '../beta.js'

export function run() {}
`
    const chunks = await treeSitterChunk('run.ts', code)
    expect(chunks).not.toBeNull()
    const imp = chunks!.find(c => c.chunkType === 'import_block')
    expect(imp).toBeDefined()
    const rels = (imp as any).relationships as Array<{ targetFile: string; relType: string }>
    expect(rels).toBeDefined()
    const targets = rels.map(r => r.targetFile)
    expect(targets).toContain('./alpha.js')
    expect(targets).toContain('../beta.js')
  })

  it('chunks content to max 80 lines', async () => {
    // 100-line function body
    const body = Array.from({ length: 100 }, (_, i) => `  const x${i} = ${i}`).join('\n')
    const code = `export function bigFn() {\n${body}\n}\n`
    const chunks = await treeSitterChunk('big.ts', code)
    expect(chunks).not.toBeNull()
    const fn = chunks!.find(c => c.chunkType === 'function')
    expect(fn).toBeDefined()
    expect(fn!.endLine - fn!.startLine).toBeLessThanOrEqual(79)
  })
})

// ─── Python ───────────────────────────────────────────────────────────────────

describe('treeSitterChunker — Python', () => {
  it('extracts a Python function', async () => {
    const code = `def greet(name: str) -> str:
    return f"Hello, {name}!"
`
    const chunks = await treeSitterChunk('greet.py', code)
    expect(chunks).not.toBeNull()
    const fn = chunks!.find(c => c.chunkType === 'function')
    expect(fn).toBeDefined()
    expect(fn!.name).toBe('greet')
  })

  it('extracts a Python class', async () => {
    const code = `class Greeter:
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}!"
`
    const chunks = await treeSitterChunk('greeter.py', code)
    expect(chunks).not.toBeNull()
    const cls = chunks!.find(c => c.chunkType === 'class')
    expect(cls).toBeDefined()
    expect(cls!.name).toBe('Greeter')
  })

  it('extracts Python import block', async () => {
    const code = `import os
from pathlib import Path

def main():
    pass
`
    const chunks = await treeSitterChunk('main.py', code)
    expect(chunks).not.toBeNull()
    const imp = chunks!.find(c => c.chunkType === 'import_block')
    expect(imp).toBeDefined()
    expect(imp!.content).toContain('import os')
  })
})

// ─── Coverage gaps found by the 2026-08-27 after-eval ─────────────────────────
// wed_match (marriages.py:209, method past the class chunk's 80-line cap) and
// TREASURY_LABELS (houses.py:12, module-level assignment) existed in NO chunk,
// so findByName could never resolve them.

describe('treeSitterChunker — class methods get their own named chunks', () => {
  it('a Python method past the 80-line class cap is a named function chunk', async () => {
    const filler = Array.from({ length: 90 }, (_, i) => `    x${i} = ${i}`).join('\n')
    const code = `class House:\n${filler}\n\n    def wed_match(self, other):\n        return True\n`
    const chunks = await treeSitterChunk('marriages.py', code)
    expect(chunks).not.toBeNull()
    const m = chunks!.find(c => c.name === 'wed_match')
    expect(m).toBeDefined()
    expect(m!.chunkType).toBe('function')
    expect(m!.content).toContain('def wed_match')
  })

  it('a decorated Python method is still found by name', async () => {
    const code = `class House:\n    @property\n    def treasury(self):\n        return self._gold\n`
    const chunks = await treeSitterChunk('houses.py', code)
    expect(chunks).not.toBeNull()
    const m = chunks!.find(c => c.name === 'treasury')
    expect(m).toBeDefined()
    expect(m!.chunkType).toBe('function')
  })

  it('a TypeScript class method is a named function chunk', async () => {
    const code = `export class Greeter {\n  greetLoud(): string {\n    return 'HI'\n  }\n}\n`
    const chunks = await treeSitterChunk('greeter.ts', code)
    expect(chunks).not.toBeNull()
    const m = chunks!.find(c => c.name === 'greetLoud')
    expect(m).toBeDefined()
    expect(m!.chunkType).toBe('function')
  })
})

describe('treeSitterChunker — module-level assignments', () => {
  it('a Python module-level constant is a named chunk', async () => {
    const code = `import os\n\nTREASURY_LABELS = frozenset({\n    "war",\n    "dowry",\n})\n\ndef main():\n    pass\n`
    const chunks = await treeSitterChunk('houses.py', code)
    expect(chunks).not.toBeNull()
    const c = chunks!.find(x => x.name === 'TREASURY_LABELS')
    expect(c).toBeDefined()
    expect(c!.content).toContain('frozenset')
  })

  it('a bare TS top-level const is a named chunk', async () => {
    const code = `const ACCEPT_SCORE = 0.75\n\nexport function decide() {\n  return ACCEPT_SCORE\n}\n`
    const chunks = await treeSitterChunk('ai.ts', code)
    expect(chunks).not.toBeNull()
    const c = chunks!.find(x => x.name === 'ACCEPT_SCORE')
    expect(c).toBeDefined()
  })

  it('a decorated top-level Python function is found by name', async () => {
    const code = `import functools\n\n@functools.cache\ndef can_place_informant(state):\n    return True\n`
    const chunks = await treeSitterChunk('broadsheet.py', code)
    expect(chunks).not.toBeNull()
    const c = chunks!.find(x => x.name === 'can_place_informant')
    expect(c).toBeDefined()
    expect(c!.chunkType).toBe('function')
  })
})

// ─── Unsupported ──────────────────────────────────────────────────────────────

describe('treeSitterChunker — unsupported', () => {
  it('returns null for .lua files', async () => {
    const code = `function greet(name)\n  print("Hello " .. name)\nend\n`
    const result = await treeSitterChunk('script.lua', code)
    expect(result).toBeNull()
  })
})
