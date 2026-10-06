import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
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
  it('non-file, non-Bash tools are safe; FILE_TOOLS is the documented set', () => {
    expect(grade('WebSearch', { query: 'x' }).level).toBe('safe')
    expect(grade('ProjectSearch', { query: 'x' }).level).toBe('safe')
    expect([...FILE_TOOLS].sort()).toEqual(['ApplyPatch', 'Edit', 'Glob', 'Grep', 'ImageView', 'Ls', 'MultiEdit', 'NotebookEdit', 'Read', 'ReplaceFunction', 'Write'])
  })
})
