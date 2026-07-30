import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { builtinSkillsDir, loadSkills } from '../../skills/loader.js'
import { ALL_TOOLS } from '../../tools/registry.js'

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

  /**
   * Every fixture above is written with `\n`, which is why this went unnoticed:
   * git checks the shipped SKILL.md files out with CRLF on Windows, and
   * splitFrontmatter stripped only the BOM. The retained `\r` is tolerated after
   * a plain scalar but not after a flow sequence's `]`, so YAML reported
   * "Unexpected scalar at node end" and the loader logged-and-skipped.
   *
   * Measured before the fix: ALL SEVEN shipped built-in skills failed to load on
   * this checkout. Both forms are pinned here — `tools: [a, b]` is the one that
   * actually broke, and the block form is the control that always worked.
   */
  it('parses frontmatter from a CRLF file, including a flow sequence', async () => {
    const crlfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skills-crlf-'))
    try {
      for (const [name, tools] of [['flowseq', '[Read, Write]'], ['blockseq', '\n  - Read\n  - Write']]) {
        const dir = path.join(crlfDir, name)
        fs.mkdirSync(dir, { recursive: true })
        const text = `---\nname: ${name}\ndescription: A CRLF skill\ntools: ${tools}\n---\n# Body\n`
        fs.writeFileSync(path.join(dir, 'SKILL.md'), text.replace(/\n/g, '\r\n'))
      }
      const { skills } = await loadSkills({ builtinDir: crlfDir, workspaceDir, knownTools: KNOWN })
      const flow = skills.find(s => s.frontmatter.name === 'flowseq')
      expect(flow).toBeDefined()
      expect(flow!.frontmatter.tools).toEqual(['Read', 'Write'])
      expect(skills.find(s => s.frontmatter.name === 'blockseq')?.frontmatter.tools)
        .toEqual(['Read', 'Write'])
    } finally {
      fs.rmSync(crlfDir, { recursive: true, force: true })
    }
  })

  /**
   * The subject here is the SHIPPED artifacts, not a fixture. A synthetic CRLF
   * skill proves the parser; only the real files prove that what CynCo ships
   * actually loads on the checkout it is running from.
   */
  it('every shipped built-in skill loads', async () => {
    const dir = builtinSkillsDir()
    const shipped = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map(e => e.name)
      .sort()
    expect(shipped.length).toBeGreaterThan(0)

    const { skills } = await loadSkills({
      builtinDir: dir,
      workspaceDir: path.join(os.tmpdir(), 'cynco-nonexistent-xyz'),
      knownTools: new Set(ALL_TOOLS.map(t => t.name)),
    })
    expect(skills.map(s => s.frontmatter.name).sort()).toEqual(shipped)
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
