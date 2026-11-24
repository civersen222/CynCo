/**
 * engine/realPath.ts: the entry kinds a folder's own listing gives (`listEntries`, `isLinkEntry`)
 * and the check that a folder the listing named is where its path says (`whyNotAtOwnPath`). The
 * containment walks (F242) take an entry's kind from these, never from lstat: lstat follows a
 * junction made by a low-integrity process (measured 2026-11-24; the low-made form is exercised in
 * `containment.test.ts`, which can make one). Everything here is made inside one mkdtemp folder;
 * the link this test makes is removed as an entry before the folder is removed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { isLinkEntry, listEntries, whyNotAtOwnPath } from '../realPath.js'

let dir: string
let links: string[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cynco-realpath-')))
  links = []
  mkdirSync(join(dir, 'folder'))
  writeFileSync(join(dir, 'folder', 'inside.txt'), 'x')
  writeFileSync(join(dir, 'file.txt'), 'x')
  mkdirSync(join(dir, 'target'))
  // A junction on Windows (made at medium integrity here), a symbolic link to a folder elsewhere.
  symlinkSync(join(dir, 'target'), join(dir, 'jn'), 'junction')
  links.push(join(dir, 'jn'))
})

afterEach(() => {
  // Each link is removed as an entry with one non-recursive call before the folder goes; one that
  // cannot be is named, and the folder is still removed.
  for (const l of links) {
    try {
      rmdirSync(l)
    } catch (asFolder) {
      try {
        unlinkSync(l)
      } catch (asFile) {
        console.log(`[realPath] the clean-up could not remove the link ${l} (rmdir: ${(asFolder as Error).message}; unlink: ${(asFile as Error).message})`)
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('listEntries', () => {
  it('gives each entry the kind its folder\'s listing gives it: a link, a folder, a file', () => {
    const got = Object.fromEntries(listEntries(dir).map(e => [e.name, e.kind]))
    expect(got).toEqual({ folder: 'dir', 'file.txt': 'file', target: 'dir', jn: 'link' })
  })

  it('throws what readdirSync throws for a folder that is not there', () => {
    expect(() => listEntries(join(dir, 'none'))).toThrow(/ENOENT/)
  })
})

describe('isLinkEntry', () => {
  it('true for the link, false for a folder and a file', () => {
    expect(isLinkEntry(join(dir, 'jn'))).toBe(true)
    expect(isLinkEntry(join(dir, 'folder'))).toBe(false)
    expect(isLinkEntry(join(dir, 'file.txt'))).toBe(false)
  })

  it('a name in another case is found on Windows, and is not there elsewhere', () => {
    if (process.platform === 'win32') {
      expect(isLinkEntry(join(dir, 'JN'))).toBe(true)
      expect(isLinkEntry(join(dir, 'FOLDER'))).toBe(false)
    } else {
      expect(isLinkEntry(join(dir, 'JN'))).toBeNull()
    }
  })

  it('null when the name is not in the listing, or the parent does not exist', () => {
    expect(isLinkEntry(join(dir, 'missing'))).toBeNull()
    expect(isLinkEntry(join(dir, 'no-such-parent', 'x'))).toBeNull()
  })

  it('a volume root is an entry of nothing: false', () => {
    expect(isLinkEntry(parse(dir).root)).toBe(false)
  })
})

describe('whyNotAtOwnPath', () => {
  it('null for a folder that is where its parent\'s real path and its name say', () => {
    expect(whyNotAtOwnPath(dir, 'folder')).toBeNull()
  })

  it('a reason for a link to a folder: it resolves somewhere else', () => {
    const why = whyNotAtOwnPath(dir, 'jn')
    expect(why).toBe(`resolves to ${join(dir, 'target')}, not to ${join(dir, 'jn')}`)
  })

  it('compares without case on Windows only', () => {
    if (process.platform === 'win32') expect(whyNotAtOwnPath(dir.toUpperCase(), 'folder')).toBeNull()
    else expect(whyNotAtOwnPath(dir.toUpperCase(), 'folder')).not.toBeNull()
  })

  it('a reason, never a throw, for a name that is not there', () => {
    expect(whyNotAtOwnPath(dir, 'missing')).toMatch(/^could not be resolved to its real path \(.*ENOENT/)
  })
})
