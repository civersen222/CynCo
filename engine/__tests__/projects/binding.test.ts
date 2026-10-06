import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gradeProjectCall, FILE_TOOLS } from '../../projects/binding.js'
import { classifyRisk, describeRisk } from '../../bridge/guardianRules.js'

const root = 'C:/p/diorama'
const grade = (tool: string, input: Record<string, unknown>) => gradeProjectCall(root, root, classifyRisk, describeRisk, tool, input)

describe('gradeProjectCall', () => {
  it('safe commands run, risky ones ask, dangerous ones are refused with the classifier\'s words', () => {
    expect(grade('Bash', { command: 'python -c "print(400*1.1)"' }).level).toBe('safe')
    expect(grade('Bash', { command: 'sudo apt install x' }).level).toBe('risky')
    const d = grade('Bash', { command: 'rm -rf knowledge' })
    expect(d.level).toBe('dangerous')
    expect(d.reason.length).toBeGreaterThan(0)
  })
  it('every download is risky, whatever the classifier says, including git clone', () => {
    expect(grade('Bash', { command: 'curl -O https://x/y.zip' })).toEqual({ level: 'risky', reason: 'downloads need your approval' })
    expect(grade('Bash', { command: 'git clone https://x/y' }).level).toBe('risky')
    expect(grade('Bash', { command: 'pip install foo' }).level).toBe('risky')
  })
  it('file tools inside the root are safe; outside it they are dangerous and name the resolved path', () => {
    expect(grade('Write', { file_path: 'artifacts/a.md', content: 'x' })).toEqual({ level: 'safe', reason: '' })
    expect(grade('Read', { file_path: join(root, 'knowledge', 'a.md') }).level).toBe('safe')
    const out = grade('Write', { file_path: '../other-project/notes.md', content: 'x' })
    expect(out.level).toBe('dangerous')
    expect(out.reason).toMatch(/outside the project folder/)
    expect(out.reason).toContain('other-project')
    expect(grade('Grep', { pattern: 'x', path: 'C:/Windows' }).level).toBe('dangerous')
    expect(grade('Glob', { pattern: '**/*.md' }).level).toBe('safe')
  })
  it('a Glob pattern that climbs out or is absolute is dangerous, naming the pattern (final review I3)', () => {
    for (const pattern of ['../**/*.md', '../other-project/**/*.md', 'knowledge/../../x/*', 'C:/Users/**/*.md', '/etc/*', '\\\\server\\share\\*']) {
      const g = grade('Glob', { pattern })
      expect(g.level, pattern).toBe('dangerous')
      expect(g.reason).toBe(`the Glob pattern reaches outside the project folder: ${pattern}`)
    }
    expect(grade('Glob', { pattern: 'knowledge/**/*.md' }).level).toBe('safe')
    expect(grade('Glob', { pattern: '**/*..md' }).level).toBe('safe') // `..` inside a name is not a segment
    // Grep's glob is a filter under its dir and cannot escape
    expect(grade('Grep', { pattern: 'x', glob: '../**/*.md' }).level).toBe('safe')
  })

  it('a junction inside the project that points outside it is outside: judged on the real path (final review I2)', () => {
    const base = mkdtempSync(join(tmpdir(), 'cynco-junction-'))
    const project = join(base, 'diorama'), outside = join(base, 'secrets')
    mkdirSync(join(project, 'knowledge'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'id_rsa'), 'key', 'utf8')
    // A junction needs no privilege on Windows (`mklink /J`); elsewhere this is a dir symlink.
    symlinkSync(outside, join(project, 'knowledge', 'h'), 'junction')
    const g = (tool: string, input: Record<string, unknown>) => gradeProjectCall(project, project, classifyRisk, describeRisk, tool, input)
    const read = g('Read', { file_path: 'knowledge/h/id_rsa' })
    expect(read.level).toBe('dangerous')
    expect(read.reason).toBe(`outside the project folder: ${join(realpathSync.native(outside), 'id_rsa')}`)
    // a file that does not exist yet behind the link lands outside too
    expect(g('Write', { file_path: 'knowledge/h/new.md', content: 'x' }).level).toBe('dangerous')
    expect(g('Glob', { pattern: '*', path: 'knowledge/h' }).level).toBe('dangerous')
    // a dangling link is judged by where it points, not by its own lexical place
    symlinkSync(join(base, 'not-yet'), join(project, 'knowledge', 'd'), 'junction')
    const dangling = g('Write', { file_path: 'knowledge/d/x.md', content: 'x' })
    expect(dangling.level).toBe('dangerous')
    expect(dangling.reason).toContain('not-yet')
    // a link that stays inside the project is fine, and so is a plain new file
    mkdirSync(join(project, 'artifacts'))
    symlinkSync(join(project, 'artifacts'), join(project, 'knowledge', 'a'), 'junction')
    expect(g('Read', { file_path: 'knowledge/a/x.md' }).level).toBe('safe')
    expect(g('Write', { file_path: 'knowledge/new/deeper/x.md', content: 'x' }).level).toBe('safe')
    rmSync(base, { recursive: true, force: true })
  })

  it('non-file, non-Bash tools are safe; FILE_TOOLS is the documented set', () => {
    expect(grade('WebSearch', { query: 'x' }).level).toBe('safe')
    expect(grade('ProjectSearch', { query: 'x' }).level).toBe('safe')
    expect([...FILE_TOOLS].sort()).toEqual(['ApplyPatch', 'Edit', 'Glob', 'Grep', 'ImageView', 'Ls', 'MultiEdit', 'NotebookEdit', 'Read', 'ReplaceFunction', 'Write'])
  })
})
