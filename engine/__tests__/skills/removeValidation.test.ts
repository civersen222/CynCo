import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { assertInside, resolveWorkspaceSkillDir } from '../../skills/loader.js'
import { SKILL_NAME_RE } from '../../skills/types.js'

// Regression origin: `/skill remove <name>` did
//   const dir = path.join(workspaceSkillsDir(), name)
//   if (!fs.existsSync(dir)) throw ...
//   fs.rmSync(dir, { recursive: true, force: true })
// on a raw argv token. `path.join` resolves `..`, and the `existsSync` guard
// only confirms the target is there to be destroyed, so
// `/skill remove ../../Documents` deleted an arbitrary directory — silently,
// unrecoverably, and reachable from the dashboard WebSocket. `/skill new` and
// `/skill install` each validated the same value with the same pattern; remove
// was the one that did not. These tests pin the shared chokepoint.

describe('resolveWorkspaceSkillDir — traversal', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skills-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const ESCAPES = [
    '..',
    '.',
    '../..',
    '../../Documents',
    '../sibling',
    'a/../..',
    'nested/child',
    path.sep === '\\' ? 'C:\\Windows' : '/etc',
    '..\\..\\Documents',
    './x',
    '',
  ]

  for (const bad of ESCAPES) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => resolveWorkspaceSkillDir(bad, root)).toThrow()
    })
  }

  it('refuses a non-string name', () => {
    expect(() => resolveWorkspaceSkillDir(undefined as unknown as string, root)).toThrow()
    expect(() => resolveWorkspaceSkillDir(null as unknown as string, root)).toThrow()
  })

  it('never returns a path outside the workspace dir, for any input it accepts', () => {
    // The property, not the enumeration: whatever it returns is contained.
    const candidates = [...ESCAPES, 'good-skill', 'a', 'a1-b2', 'x'.repeat(80)]
    for (const c of candidates) {
      let dir: string | null = null
      try {
        dir = resolveWorkspaceSkillDir(c, root)
      } catch {
        continue // rejected — that is the other half of the contract
      }
      expect(dir.startsWith(path.resolve(root) + path.sep)).toBe(true)
    }
  })

  it('accepts a lower-kebab-case name and resolves it inside the workspace dir', () => {
    const dir = resolveWorkspaceSkillDir('my-skill', root)
    expect(dir).toBe(path.join(path.resolve(root), 'my-skill'))
  })

  it('is the same rule /skill new and /skill install enforce', () => {
    // One pattern, one place — the drift between three private copies is what
    // let remove ship without any.
    expect(SKILL_NAME_RE.test('my-skill')).toBe(true)
    expect(SKILL_NAME_RE.test('..')).toBe(false)
    expect(SKILL_NAME_RE.test('../..')).toBe(false)
    expect(SKILL_NAME_RE.test('Nope')).toBe(false)
  })

  // The containment assert sits BEHIND the name rule, so nothing that reaches
  // resolveWorkspaceSkillDir can ever exercise it — mutate it away and the
  // tests above all still pass. That is what makes a backstop decorative. It
  // is specified separately here so it is measured on its own terms, against
  // the inputs a future caller (or a loosened regex) would actually hand it.
  describe('assertInside — the backstop, on its own terms', () => {
    for (const bad of ['..', '.', '../..', '../../Documents', 'a/../..', '', './..']) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        expect(() => assertInside(root, bad)).toThrow()
      })
    }

    it('refuses an absolute path pointing elsewhere', () => {
      const elsewhere = path.resolve(root, '..')
      expect(() => assertInside(root, elsewhere)).toThrow()
    })

    it('refuses the root itself — a skill dir is strictly inside it', () => {
      expect(() => assertInside(root, path.resolve(root))).toThrow()
    })

    it('accepts a contained path and returns it resolved', () => {
      expect(assertInside(root, 'ok')).toBe(path.join(path.resolve(root), 'ok'))
      expect(assertInside(root, 'nested/child'))
        .toBe(path.join(path.resolve(root), 'nested', 'child'))
    })

    it('is not fooled by a sibling directory sharing the root as a prefix', () => {
      // `<root>-evil` startsWith `<root>` as a plain string; the separator in
      // the check is what makes that a rejection rather than an acceptance.
      const sibling = path.resolve(root) + '-evil'
      expect(() => assertInside(root, sibling)).toThrow()
    })
  })

  it('a rejected name deletes nothing', () => {
    // The end-to-end property the finding is actually about.
    const victim = path.join(root, '..', 'cynco-victim-dir')
    fs.mkdirSync(victim, { recursive: true })
    try {
      expect(() => resolveWorkspaceSkillDir('../cynco-victim-dir', root)).toThrow()
      expect(fs.existsSync(victim)).toBe(true)
    } finally {
      fs.rmSync(victim, { recursive: true, force: true })
    }
  })
})
