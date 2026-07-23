import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runSkillTool, listSkillsTool } from '../../tools/impl/skillTools.js'
import { setLoadedSkills } from '../../skills/store.js'
import type { Skill } from '../../skills/types.js'

let dir: string
let tddBodyPath: string

function makeSkill(name: string, description: string, tools: string[], source: Skill['source'], bodyPath: string): Skill {
  return { frontmatter: { name, description, tools }, dir: path.dirname(bodyPath), source, bodyPath }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skilltools-'))
  tddBodyPath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(tddBodyPath, '---\nname: tdd\ndescription: TDD loop\ntools:\n  - Read\n---\n# TDD\nWrite the failing test first.\n')
  setLoadedSkills([
    makeSkill('tdd', 'TDD loop', ['Read'], 'builtin', tddBodyPath),
    makeSkill('helper', 'A helper', [], 'workspace', tddBodyPath),
  ])
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  setLoadedSkills([])
})

describe('run_skill / list_skills meta-tools', () => {
  it('are core, auto-tier meta-tools', () => {
    expect(runSkillTool.core).toBe(true)
    expect(runSkillTool.tier).toBe('auto')
    expect(listSkillsTool.core).toBe(true)
    expect(listSkillsTool.tier).toBe('auto')
  })

  it('run_skill returns the skill body without the frontmatter fence', async () => {
    const res = await runSkillTool.execute({ name: 'tdd' }, dir)
    expect(res.isError).toBe(false)
    expect(res.output).toContain('Write the failing test first.')
    expect(res.output).not.toContain('description: TDD loop')
    expect(res.output).not.toMatch(/^---/)
  })

  it('run_skill errors on an unknown skill', async () => {
    const res = await runSkillTool.execute({ name: 'nope' }, dir)
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/unknown skill/i)
  })

  it('run_skill errors when name is missing', async () => {
    const res = await runSkillTool.execute({}, dir)
    expect(res.isError).toBe(true)
  })

  it('list_skills lists every loaded skill with its description and source', async () => {
    const res = await listSkillsTool.execute({}, dir)
    expect(res.isError).toBe(false)
    expect(res.output).toContain('tdd')
    expect(res.output).toContain('TDD loop')
    expect(res.output).toContain('helper')
  })
})
