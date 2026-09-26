/**
 * The jlens artifacts dir follows `cyncoHome()` (F161 residual, closed in
 * Phase 5 Task 1): an engine under a temp `CYNCO_HOME` must not reach into the
 * operator's real `~/.cynco/jlens`. `JLENS_DIR` still wins; empty is unset.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { jlensArtifactsDir } from '../../brain/jlensSidecar.js'

let home: string
let prevHome: string | undefined
let prevJlens: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-jlens-home-'))
  prevHome = process.env.CYNCO_HOME
  prevJlens = process.env.JLENS_DIR
  process.env.CYNCO_HOME = home
  delete process.env.JLENS_DIR
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prevHome
  if (prevJlens === undefined) delete process.env.JLENS_DIR; else process.env.JLENS_DIR = prevJlens
  rmSync(home, { recursive: true, force: true })
})

describe('jlensArtifactsDir under cyncoHome()', () => {
  it('resolves under a temp CYNCO_HOME, not the real ~/.cynco', () => {
    expect(jlensArtifactsDir()).toBe(join(home, 'jlens'))
    expect(jlensArtifactsDir().startsWith(join(homedir(), '.cynco'))).toBe(false)
  })

  it('JLENS_DIR wins over CYNCO_HOME', () => {
    const lens = join(tmpdir(), 'elsewhere-lens')
    process.env.JLENS_DIR = lens
    expect(jlensArtifactsDir()).toBe(lens)
  })

  it('an empty JLENS_DIR is unset', () => {
    process.env.JLENS_DIR = ''
    expect(jlensArtifactsDir()).toBe(join(home, 'jlens'))
  })
})
