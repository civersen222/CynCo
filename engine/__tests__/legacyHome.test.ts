/**
 * Which engine may adopt the pre-rename state folder, `~/.localcode` (F241).
 *
 * The engine renames `~/.localcode` to its home when the legacy folder exists and the home does
 * not. That was written for the one-time move to `~/.cynco`. But the home can be redirected
 * (`CYNCO_HOME`), which is how a second engine, a test engine or a campaign is kept out of the
 * live state: on 2026-11-17 a scratch engine whose `CYNCO_HOME` named a folder that did not exist
 * yet took the owner's `~/.localcode` as that folder, and the start-up clean-up then deleted the
 * 53 session journals in it that were older than thirty days. A redirected home is somebody's
 * scratch space. It never gets the user's legacy state.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { shouldAdoptLegacyHome } from '../paths.js'

describe('shouldAdoptLegacyHome', () => {
  it('the one-time move: the legacy folder is there, the default home is not', () => {
    expect(shouldAdoptLegacyHome({ legacyExists: true, homeExists: false, env: {} })).toBe(true)
    expect(shouldAdoptLegacyHome({ legacyExists: true, homeExists: false, env: { CYNCO_HOME: '' } })).toBe(true) // empty is unset, as in cyncoHome()
  })

  it('never when the home is redirected, whether or not that folder exists yet', () => {
    expect(shouldAdoptLegacyHome({ legacyExists: true, homeExists: false, env: { CYNCO_HOME: 'C:/tmp/scratch-home' } })).toBe(false)
    expect(shouldAdoptLegacyHome({ legacyExists: true, homeExists: true, env: { CYNCO_HOME: 'C:/tmp/scratch-home' } })).toBe(false)
  })

  it('never onto a home that is already there, and never without a legacy folder', () => {
    expect(shouldAdoptLegacyHome({ legacyExists: true, homeExists: true, env: {} })).toBe(false)
    expect(shouldAdoptLegacyHome({ legacyExists: false, homeExists: false, env: {} })).toBe(false)
  })
})

describe('the engine asks before it renames (wiring, by text)', () => {
  it('main.ts renames only where shouldAdoptLegacyHome says so', () => {
    const src = readFileSync(join(process.cwd(), 'engine', 'main.ts'), 'utf-8')
    const rename = src.indexOf('fs.renameSync(oldDir, newDir)')
    expect(rename).toBeGreaterThan(-1)
    const before = src.slice(rename - 400, rename)
    expect(before).toContain('shouldAdoptLegacyHome({')
    expect(before).not.toContain('if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {')
  })
})
