import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadSkills } from '../../skills/loader.js'

const KNOWN = new Set(['Read', 'Write', 'Bash', 'Grep'])

let builtinDir: string
let workspaceDir: string

function writeSkill(root: string, name: string, frontmatter: string, body: string) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
  return dir
}

beforeAll(() => {
  builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skills-builtin-'))
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skills-ws-'))

  writeSkill(
    builtinDir,
    'tdd',
    'name: tdd\ndescription: Test-driven development loop\ntools:\n  - Read\n  - Write',
    '# TDD\nWrite the test first.',
  )
  writeSkill(
    workspaceDir,
    'my-helper',
    'name: my-helper\ndescription: A user-installed helper\ntools: []',
    '# Helper\nDo the thing.',
  )
  // A malformed skill must be skipped, not crash the whole scan.
  writeSkill(workspaceDir, 'broken', 'name: Bad Name\ndescription: nope', '# Broken')
})

afterAll(() => {
  fs.rmSync(builtinDir, { recursive: true, force: true })
  fs.rmSync(workspaceDir, { recursive: true, force: true })
})

describe('loadSkills', () => {
  it('discovers valid skills from both builtin and workspace dirs', async () => {
    const { skills, index } = await loadSkills({ builtinDir, workspaceDir, knownTools: KNOWN })
    const names = skills.map(s => s.frontmatter.name).sort()
    expect(names).toEqual(['my-helper', 'tdd'])

    const tdd = skills.find(s => s.frontmatter.name === 'tdd')!
    expect(tdd.source).toBe('builtin')
    expect(tdd.frontmatter.tools).toEqual(['Read', 'Write'])

    const helper = skills.find(s => s.frontmatter.name === 'my-helper')!
    expect(helper.source).toBe('workspace')

    expect(index).toContainEqual({ name: 'tdd', description: 'Test-driven development loop', source: 'builtin' })
  })

  it('skips malformed skills without throwing', async () => {
    const { skills } = await loadSkills({ builtinDir, workspaceDir, knownTools: KNOWN })
    expect(skills.find(s => (s.frontmatter as any).name === 'Bad Name')).toBeUndefined()
    expect(skills.some(s => s.dir.endsWith('broken'))).toBe(false)
  })

  it('loads the body lazily from bodyPath', async () => {
    const { skills } = await loadSkills({ builtinDir, workspaceDir, knownTools: KNOWN })
    const tdd = skills.find(s => s.frontmatter.name === 'tdd')!
    const body = fs.readFileSync(tdd.bodyPath, 'utf8')
    expect(body).toContain('Write the test first.')
    // bodyPath must NOT include the frontmatter fence in the returned index.
    expect(tdd.frontmatter.description).not.toContain('---')
  })

  it('returns empty when directories do not exist', async () => {
    const { skills, index } = await loadSkills({
      builtinDir: path.join(os.tmpdir(), 'cynco-nonexistent-xyz'),
      workspaceDir: path.join(os.tmpdir(), 'cynco-nonexistent-abc'),
      knownTools: KNOWN,
    })
    expect(skills).toEqual([])
    expect(index).toEqual([])
  })
})
