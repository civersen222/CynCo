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

// ─── Unsupported ──────────────────────────────────────────────────────────────

describe('treeSitterChunker — unsupported', () => {
  it('returns null for .lua files', async () => {
    const code = `function greet(name)\n  print("Hello " .. name)\nend\n`
    const result = await treeSitterChunk('script.lua', code)
    expect(result).toBeNull()
  })
})
