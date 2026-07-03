import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildConceptTableForCwd, clearConceptTableCache } from '../../vsm/conceptTable.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concept-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'city.py'), 'class City:\n    def __init__(self):\n        self.happiness = 0\n')
  writeFileSync(
    join(dir, 'sub', 'game.py'),
    'class Game:\n    def __init__(self):\n        self.happiness = {}\n        self.happiness_system = HS()\n',
  )
  writeFileSync(join(dir, 'sub', 'happiness_system.py'), 'class HS:\n    pass\n')
  // noise that must be ignored
  writeFileSync(join(dir, 'node_modules', 'pkg', 'stability_system.py'), 'self.stability = 1\n')
  clearConceptTableCache()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildConceptTableForCwd', () => {
  it('builds the collision table from .py files under cwd', () => {
    const t = buildConceptTableForCwd(dir)
    expect(t.has('happiness')).toBe(true)
    expect(t.get('happiness')!.systemSource).toBe('happiness_system')
  })

  it('ignores node_modules and non-.py files', () => {
    const t = buildConceptTableForCwd(dir)
    expect(t.has('stability')).toBe(false)
  })

  it('returns an empty table for a cwd with no .py files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'))
    try {
      expect(buildConceptTableForCwd(empty).size).toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
