import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scaffoldSkill } from '../../skills/scaffold.js'
import { validateFrontmatter } from '../../skills/types.js'

let workspaceDir: string

beforeEach(() => { workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-scaffold-')) })
afterEach(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }) })

function readFrontmatter(file: string): string {
  const t = fs.readFileSync(file, 'utf8')
  const end = t.indexOf('\n---', 3)
  return t.slice(t.indexOf('\n') + 1, end)
}

describe('scaffoldSkill', () => {
  it('creates a skill folder with a valid template SKILL.md', () => {
    const res = scaffoldSkill('my-skill', { workspaceDir })
    expect(res.dir).toBe(path.join(workspaceDir, 'my-skill'))
    const skillMd = path.join(res.dir, 'SKILL.md')
    expect(fs.existsSync(skillMd)).toBe(true)

    // The template frontmatter must itself pass validation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('yaml') as typeof import('yaml')
    const fm = validateFrontmatter(yaml.parse(readFrontmatter(skillMd)), new Set())
    expect(fm.name).toBe('my-skill')
    expect(fm.tools).toEqual([])
  })

  it('rejects a non-kebab-case name', () => {
    expect(() => scaffoldSkill('My Skill', { workspaceDir })).toThrow(/kebab/)
  })

  it('refuses to overwrite an existing skill', () => {
    scaffoldSkill('dup', { workspaceDir })
    expect(() => scaffoldSkill('dup', { workspaceDir })).toThrow(/exists/i)
  })
})
