import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll } from 'bun:test'
import { gradeProjectCall, FILE_TOOLS, COMFY_FENCE_REASON, COMFY_MENTION_REASON, comfyHostFromEnv, comfyFence } from '../../projects/binding.js'
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
  const asks = { level: 'risky', reason: COMFY_MENTION_REASON }

  it('names the reason and the way to ask', () => {
    expect(COMFY_FENCE_REASON).toBe('pictures are made by the engine from RenderUI Image prompts; a project chat never drives ComfyUI itself — ask with an Image prompt (and a seed for another take)')
  })

  it('curl, Invoke-RestMethod and python requests at the configured server are dangerous, before the download rule', () => {
    expect(grade('Bash', { command: 'curl -s -X POST http://192.168.0.47:8188/prompt -H "Content-Type: application/json" -d @tower/workflow.json' })).toEqual(fenced)
    expect(grade('Bash', { command: 'curl -s http://192.168.0.47:8188/system_stats' })).toEqual(fenced)
    expect(grade('Bash', { command: 'Invoke-RestMethod -Uri "http://192.168.0.47:8188/prompt" -Method Post -Body $json -ContentType "application/json"' })).toEqual(fenced)
    expect(grade('Bash', { command: 'python -c "import requests; print(requests.get(\'http://192.168.0.47:8188/history/abc\').json())"' })).toEqual(fenced)
    expect(grade('Bash', { command: 'python tower/render.py --server http://192.168.0.47:8188' })).toEqual(fenced)
    expect(grade('Bash', { command: 'Invoke-WebRequest "http://192.168.0.47:8188/view?filename=x.png&type=output" -OutFile tower/renders/a.png' })).toEqual(fenced)
    // the server's host on another port is not the server
    expect(grade('Bash', { command: 'curl http://192.168.0.47:81889/x' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'ping 192.168.0.47' }).level).toBe('safe')
  })

  it("ComfyUI's API paths on any host's 8188 are dangerous too — under the /api prefix its web client uses, with a leading zero in the port, and whatever follows the route", () => {
    for (const command of [
      'curl -X POST http://10.0.0.9:8188/prompt -d @wf.json',
      'curl "http://comfy.local:8188/view?filename=x.png&type=output" -o a.png',
      'curl http://localhost:8188/object_info',
      'curl -X POST http://127.0.0.1:8188/interrupt',
      'curl http://[::1]:8188/queue',
      'python -c "import urllib.request; urllib.request.urlopen(\'http://pc:8188/history/\')"',
      'Invoke-RestMethod http://pc:8188/history/1234',
      // the /api prefix (the ComfyUI web client's own calls), the routes the live run did not reach yet
      'curl -X POST http://127.0.0.1:8188/api/prompt -d @wf.json',
      'curl "http://localhost:8188/api/view?filename=a.png&type=output"',
      'curl -F image=@x.png http://localhost:8188/upload/image',
      'curl http://localhost:8188/system_stats',
      'python -c "import websocket; websocket.create_connection(\'ws://127.0.0.1:8188/ws\')"',
      // :08188 is 8188 to curl and urllib; a redirect or a brace right after the route
      'curl http://192.168.0.47:08188/prompt -d @wf.json',
      'curl -s http://127.0.0.1:8188/queue>queue.json',
      "python -c \"import requests; requests.post(**{'url':'http://127.0.0.1:8188/prompt'})\"",
    ]) expect(grade('Bash', { command }), command).toEqual(fenced)
    // the same paths on another port, or 8188 with another path, are not ComfyUI
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8080/prompt' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8188/promptly' }).reason).not.toBe(COMFY_FENCE_REASON)
    expect(grade('Bash', { command: 'curl http://10.0.0.9:8188/api/health' }).reason).not.toBe(COMFY_FENCE_REASON)
  })

  // A reverse proxy or TLS in front of ComfyUI: LOCALCODE_COMFYUI_URL has no
  // port, comfyHostFromEnv adds the scheme's, and no command spells ":80" or
  // ":443" — the configured-host half of the fence never fired.
  it('a configured URL with no port fences the host as commands spell it, the scheme default optional', () => {
    const plain = comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'http://comfy.local' })
    expect(plain).toBe('comfy.local:80')
    expect(comfyFence('curl -X POST http://comfy.local/prompt -d @wf.json', plain)).toEqual(fenced)
    expect(comfyFence('curl -X POST http://comfy.local:80/prompt -d @wf.json', plain)).toEqual(fenced)
    expect(comfyFence('Invoke-RestMethod -Uri "http://COMFY.LOCAL/history/1"', plain)).toEqual(fenced)
    // another port on that host, a longer name, a name that ends in it: not the server
    expect(comfyFence('curl http://comfy.local:8080/x', plain)).toBeNull()
    expect(comfyFence('curl http://comfy.localhost/x', plain)).toBeNull()
    expect(comfyFence('curl http://notcomfy.local/x', plain)).toBeNull()
    const tls = comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'https://comfy.example/api' })
    expect(tls).toBe('comfy.example:443')
    expect(comfyFence('curl -X POST https://comfy.example/prompt -d @wf.json', tls)).toEqual(fenced)
    expect(comfyFence('curl -X POST https://comfy.example:443/prompt -d @wf.json', tls)).toEqual(fenced)
    // a leading zero in the configured port is the same port, and the fence matches one in a command
    expect(comfyHostFromEnv({ LOCALCODE_COMFYUI_URL: 'http://pc:08188' })).toBe('pc:8188')
    expect(comfyFence('curl http://pc:08188/x', 'pc:8188')).toEqual(fenced)
    expect(comfyFence('curl http://pc:81889/x', 'pc:8188')).toBeNull()
  })

  it('a command that reaches the server through LOCALCODE_COMFYUI_URL is fenced, not a download to approve', () => {
    expect(grade('Bash', { command: 'curl -X POST "$LOCALCODE_COMFYUI_URL/prompt" -d @wf.json' })).toEqual(fenced)
    expect(grade('Bash', { command: 'Invoke-RestMethod "$env:LOCALCODE_COMFYUI_URL/prompt" -Method Post -Body $json' })).toEqual(fenced)
    expect(grade('Bash', { command: 'python -c "import os, requests; requests.post(os.environ[\'LOCALCODE_COMFYUI_URL\'] + \'/prompt\')"' })).toEqual(fenced)
    // the name says where the command goes even when the variable is unset here
    expect(comfyFence('curl "$LOCALCODE_COMFYUI_URL/system_stats"', null)).toEqual(fenced)
  })

  // The address in an echo, a grep or a script's argument is not a call at
  // the server: it asks (the user sees the command) instead of being refused.
  it('a command that merely names the server asks; one the classifier refuses stays refused with its words', () => {
    expect(COMFY_MENTION_REASON).toBe('names the ComfyUI server — pictures are made by the engine from RenderUI Image prompts, and a project chat never drives ComfyUI itself')
    expect(grade('Bash', { command: 'echo "the server is at 192.168.0.47:8188, ask with an Image prompt"' })).toEqual(asks)
    expect(grade('Bash', { command: 'grep -n 192.168.0.47:8188 journal.md' })).toEqual(asks)
    expect(grade('Bash', { command: 'python tower/render.py --server 192.168.0.47:8188' })).toEqual(asks)
    expect(grade('Bash', { command: 'echo $LOCALCODE_COMFYUI_URL' })).toEqual(asks)
    const d = grade('Bash', { command: 'rm -rf knowledge && echo 192.168.0.47:8188' })
    expect(d.level).toBe('dangerous')
    expect(d.reason).not.toBe(COMFY_MENTION_REASON)
  })

  // The live run's script was two safe calls: a Write of render.py with the
  // URL inside, then "python tower/render.py" — nothing for the Bash fence to
  // see. A file that drives the server is refused before it is written.
  it('a file that drives the server is refused at the Write, Edit, MultiEdit, NotebookEdit, ApplyPatch or ReplaceFunction that writes it', () => {
    expect(grade('Write', { file_path: 'tower/render.py', content: 'import requests\nrequests.post("http://192.168.0.47:8188/prompt", json=wf)\n' })).toEqual(fenced)
    expect(grade('Write', { file_path: 'tower/render.py', content: 'import os, requests\nrequests.post(os.environ["LOCALCODE_COMFYUI_URL"] + "/prompt", json=wf)\n' })).toEqual(fenced)
    expect(grade('Write', { file_path: 'tower/render.ps1', content: 'Invoke-RestMethod -Uri "http://127.0.0.1:8188/api/prompt" -Method Post -Body $json' })).toEqual(fenced)
    expect(grade('Edit', { file_path: 'tower/render.py', old_string: 'pass', new_string: 'urllib.request.urlopen("http://192.168.0.47:8188/history/")' })).toEqual(fenced)
    expect(grade('MultiEdit', { file_path: 'tower/render.py', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'fetch("http://localhost:8188/view?filename=a.png")' }] })).toEqual(fenced)
    expect(grade('NotebookEdit', { notebook_path: 'tower/r.ipynb', new_source: 'requests.get("http://192.168.0.47:8188/system_stats")' })).toEqual(fenced)
    expect(grade('ApplyPatch', { patch: '*** Update File: run.sh\n+curl http://192.168.0.47:8188/prompt' })).toEqual(fenced)
    expect(grade('ReplaceFunction', { file_path: 'tower/render.py', function_name: 'go', new_body: 'return httpx.post("http://192.168.0.47:8188/prompt")' })).toEqual(fenced)
    // the path rule comes first: a script outside the project is outside
    expect(grade('Write', { file_path: '../elsewhere/render.py', content: 'requests.post("http://192.168.0.47:8188/prompt")' }).reason).toMatch(/outside the project folder/)
    // a note that names the server, a workflow graph, a prompt file: written
    expect(grade('Write', { file_path: 'notes.md', content: 'ComfyUI runs on 192.168.0.47:8188; ask with an Image prompt.' })).toEqual({ level: 'safe', reason: '' })
    expect(grade('Write', { file_path: 'tower/workflow.json', content: '{"3": {"class_type": "KSampler", "inputs": {"seed": 1}}}' })).toEqual({ level: 'safe', reason: '' })
    expect(grade('Write', { file_path: 'tower/prompts/a.txt', content: 'a tall green alien, studio light' })).toEqual({ level: 'safe', reason: '' })
    expect(grade('Edit', { file_path: 'plan.md', old_string: 'a', new_string: 'b' })).toEqual({ level: 'safe', reason: '' })
    // the Bash that runs a script is graded on its own text
    expect(grade('Bash', { command: 'python tower/render.py' })).toEqual({ level: 'safe', reason: '' })
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
