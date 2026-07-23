import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseInstallSpec, installSkill } from '../../skills/install.js'

const KNOWN = new Set(['Read', 'Write', 'Bash', 'Grep', 'WebFetch'])

describe('parseInstallSpec', () => {
  it('parses owner/repo', () => {
    expect(parseInstallSpec('acme/skills')).toEqual({ owner: 'acme', repo: 'skills', ref: undefined, subdir: undefined })
  })
  it('parses a ref', () => {
    expect(parseInstallSpec('acme/skills@v2')).toEqual({ owner: 'acme', repo: 'skills', ref: 'v2', subdir: undefined })
  })
  it('parses a subdir', () => {
    expect(parseInstallSpec('acme/skills/pack/tdd')).toEqual({ owner: 'acme', repo: 'skills', ref: undefined, subdir: 'pack/tdd' })
  })
  it('parses a subdir with a ref', () => {
    expect(parseInstallSpec('acme/skills/pack/tdd@main')).toEqual({ owner: 'acme', repo: 'skills', ref: 'main', subdir: 'pack/tdd' })
  })
  it('rejects a malformed spec', () => {
    expect(() => parseInstallSpec('justrepo')).toThrow()
  })
})

describe('installSkill', () => {
  let workspaceDir: string
  let extractRoot: string

  // Build a directory that mimics a GitHub zipball extracted to a temp dir:
  // everything nested under `<repo>-<ref>/`.
  function stageExtractedZipball(skillName: string, frontmatter: string, subdir?: string) {
    const nested = path.join(extractRoot, 'skills-main')
    const skillDir = subdir ? path.join(nested, subdir) : path.join(nested, skillName)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n# Body\nDo the thing.\n`)
    fs.writeFileSync(path.join(skillDir, 'extra.txt'), 'asset')
  }

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-install-ws-'))
    extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-install-src-'))
  })
  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(extractRoot, { recursive: true, force: true })
  })

  const fetchAndExtract = async () => extractRoot

  it('installs a valid skill and copies its whole folder into the workspace', async () => {
    stageExtractedZipball('tdd', 'name: tdd\ndescription: TDD loop\ntools:\n  - Read')
    let confirmedWith = ''
    const res = await installSkill('acme/skills', {
      workspaceDir,
      knownTools: KNOWN,
      confirm: async (report) => { confirmedWith = report; return true },
      fetchAndExtract,
    })
    expect(res.installed).toBe(true)
    expect(res.name).toBe('tdd')
    expect(fs.existsSync(path.join(workspaceDir, 'tdd', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspaceDir, 'tdd', 'extra.txt'))).toBe(true)
    expect(confirmedWith).toContain('tdd')
  })

  it('flags risky tools in the confirmation report', async () => {
    stageExtractedZipball('danger', 'name: danger\ndescription: runs shell\ntools:\n  - Bash\n  - Write')
    let report = ''
    await installSkill('acme/skills', {
      workspaceDir, knownTools: KNOWN,
      confirm: async (r) => { report = r; return true },
      fetchAndExtract,
    })
    expect(report).toMatch(/risky|Bash|Write/i)
  })

  it('does not install when the user declines', async () => {
    stageExtractedZipball('tdd', 'name: tdd\ndescription: TDD loop\ntools: []')
    const res = await installSkill('acme/skills', {
      workspaceDir, knownTools: KNOWN,
      confirm: async () => false,
      fetchAndExtract,
    })
    expect(res.installed).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, 'tdd'))).toBe(false)
  })

  it('rejects a zipball whose SKILL.md fails validation', async () => {
    stageExtractedZipball('bad', 'name: Bad Name\ndescription: nope\ntools: []')
    await expect(
      installSkill('acme/skills', {
        workspaceDir, knownTools: KNOWN,
        confirm: async () => true,
        fetchAndExtract,
      }),
    ).rejects.toThrow(/kebab|frontmatter/i)
  })

  it('locates the skill via subdir when given one', async () => {
    stageExtractedZipball('tdd', 'name: nested-skill\ndescription: nested\ntools: []', 'pack/inner')
    const res = await installSkill('acme/skills/pack/inner', {
      workspaceDir, knownTools: KNOWN,
      confirm: async () => true,
      fetchAndExtract,
    })
    expect(res.installed).toBe(true)
    expect(res.name).toBe('nested-skill')
    expect(fs.existsSync(path.join(workspaceDir, 'nested-skill', 'SKILL.md'))).toBe(true)
  })
})
