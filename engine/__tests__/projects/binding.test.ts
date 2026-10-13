import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll } from 'bun:test'
import { gradeProjectCall, FILE_TOOLS, COMFY_FENCE_REASON, comfyHostFromEnv } from '../../projects/binding.js'
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

// The operator's live run (2026-10-12/13): a project "directive" sent the
// model to drive ComfyUI by hand — a workflow JSON of six KSamplers, POST
// /prompt, poll /history, GET /view, renders saved under tower/renders/ —
// through Bash and PowerShell. Pictures are the engine's to make from
// RenderUI Image prompts; a command at the configured server, or at
// ComfyUI's API on any host's 8188, is refused with the way to ask instead.
describe('gradeProjectCall: the ComfyUI fence', () => {
  let prev: string | undefined
  beforeAll(() => { prev = process.env.LOCALCODE_COMFYUI_URL; process.env.LOCALCODE_COMFYUI_URL = 'http://192.168.0.47:8188' })
  afterAll(() => { if (prev === undefined) delete process.env.LOCALCODE_COMFYUI_URL; else process.env.LOCALCODE_COMFYUI_URL = prev })
  const fenced = { level: 'dangerous', reason: COMFY_FENCE_REASON }

  it('names the reason and the way to ask', () => {
    expect(COMFY_FENCE_REASON).toBe('pictures are made by the engine from RenderUI Image prompts; a project chat never drives ComfyUI itself — ask with an Image prompt (and a seed for another take)')
  })

  it('curl, Invoke-RestMethod and python requests at the configured server are dangerous, before the download rule', () => {
    expect(grade('Bash', { command: 'curl -s -X POST http://192.168.0.47:8188/prompt -H "Content-Type: application/json" -d @tower/workflow.json' })).toEqual(fenced)
    expect(grade('Bash', { command: 'curl -s http://192.168.0.47:8188/system_stats' })).toEqual(fenced)
    expect(grade('Bash', { command: 'Invoke-RestMethod -Uri "http://192.168.0.47:8188/prompt" -Method Post -Body $json -ContentType "application/json"' })).toEqual(fenced)
    expect(grade('Bash', { command: 'python -c "import requests; print(requests.get(\'http://192.168.0.47:8188/history/abc\').json())"' })).toEqual(fenced)
    expect(grade('Bash', { command: 'python tower/render.py --server 192.168.0.47:8188' })).toEqual(fenced)
    expect(grade('Bash', { command: 'Invoke-WebRequest "http://192.168.0.47:8188/view?filename=x.png&type=output" -OutFile tower/renders/a.png' })).toEqual(fenced)
    // the server's host on another port is not the server
    expect(grade('Bash', { command: 'curl http://192.168.0.47:81889/x' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'ping 192.168.0.47' }).level).toBe('safe')
  })

  it("ComfyUI's API paths on any host's 8188 are dangerous too", () => {
    for (const command of [
      'curl -X POST http://10.0.0.9:8188/prompt -d @wf.json',
      'curl "http://comfy.local:8188/view?filename=x.png&type=output" -o a.png',
      'curl http://localhost:8188/object_info',
      'curl -X POST http://127.0.0.1:8188/interrupt',
      'curl http://[::1]:8188/queue',
      'python -c "import urllib.request; urllib.request.urlopen(\'http://pc:8188/history/\')"',
      'Invoke-RestMethod http://pc:8188/history/1234',
    ]) expect(grade('Bash', { command }), command).toEqual(fenced)
    // the same paths on another port, or 8188 with another path, are not ComfyUI
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8080/prompt' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8188/promptly' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8188/api/health' }).reason).not.toBe(COMFY_FENCE_REASON)
  })

  it('a harmless mention of the word is safe, and every other grade is unchanged', () => {
    expect(grade('Bash', { command: 'echo "ComfyUI paints the tower; ask with an Image prompt"' })).toEqual({ level: 'safe', reason: '' })
    expect(grade('Bash', { command: 'python -c "print(400*1.1)"' }).level).toBe('safe')
    expect(grade('Bash', { command: 'curl -O https://x/y.zip' })).toEqual({ level: 'risky', reason: 'downloads need your approval' })
    expect(grade('Bash', { command: 'rm -rf knowledge' }).level).toBe('dangerous')
    expect(grade('Write', { file_path: 'tower/workflow.json', content: '{}' }).level).toBe('safe')
  })

  it('comfyHostFromEnv: host:port of LOCALCODE_COMFYUI_URL, lower-cased, the scheme default when no port; null when unset or not a URL', () => {
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'http://192.168.0.47:8188' })).toBe('192.168.0.47:8188')
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: ' http://Comfy-PC:8188/ ' })).toBe('comfy-pc:8188')
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'https://comfy.example/api' })).toBe('comfy.example:443')
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'http://user:pw@pc:8188' })).toBe('pc:8188')
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'http://[::1]:8188' })).toBe('[::1]:8188')
    expect(comfyHostFromEnv({})).toBeNull()
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: '   ' })).toBeNull()
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'pc:8188' })).toBeNull()
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'ftp://pc:8188' })).toBeNull()
    // the fence stands without the variable: the API paths on 8188
    const unset = { ...process.env }
    delete unset.LOCALCODE_COMFYUI_URL
    expect(comfyHostFromEnv(unset)).toBeNull()
  })
})
