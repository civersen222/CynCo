/**
 * The workspace skills dir follows `cyncoHome()` (F161 residual, closed in
 * Phase 5 Task 1). It used to be `$HOME/.cynco/skills`, the one skills path a
 * temp `CYNCO_HOME` did not redirect — so a campaign under a temp home loaded
 * (and `/skill install` wrote into) the operator's real skills.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { workspaceSkillsDir, loadSkills } from '../../skills/loader.js'

let root: string
let prevHome: string | undefined
let prevCyncoHome: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cynco-skills-home-'))
  prevHome = process.env.HOME
  prevCyncoHome = process.env.CYNCO_HOME
  // HOME and CYNCO_HOME point at DIFFERENT places, so the test can tell which one won.
  process.env.HOME = join(root, 'home')
  process.env.CYNCO_HOME = join(root, 'cynco-home')
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
  if (prevCyncoHome === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prevCyncoHome
  rmSync(root, { recursive: true, force: true })
})

describe('workspaceSkillsDir under cyncoHome()', () => {
  it('resolves to <CYNCO_HOME>/skills, not <HOME>/.cynco/skills', () => {
    expect(workspaceSkillsDir()).toBe(join(root, 'cynco-home', 'skills'))
  })

  it('a skill planted under CYNCO_HOME is the one loadSkills finds', async () => {
    const dir = join(root, 'cynco-home', 'skills', 'home-probe')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: home-probe\ndescription: probe\n---\nbody\n')
    const decoy = join(root, 'home', '.cynco', 'skills', 'home-decoy')
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(decoy, 'SKILL.md'), '---\nname: home-decoy\ndescription: decoy\n---\nbody\n')
    // Default dirs: the workspace dir comes from workspaceSkillsDir(), i.e. cyncoHome().
    const { index } = await loadSkills({ knownTools: new Set<string>() })
    const names = index.map(s => s.name)
    expect(names).toContain('home-probe')
    expect(names).not.toContain('home-decoy')
  })
})
