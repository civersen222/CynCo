/**
 * F242, slice S2a: every engine site that starts a child which runs workspace code goes through
 * the containment (engine/containment.ts): the Bash tool, the Git tool, ApplyPatch, best-of-N test
 * runs, LSP diagnostics and the contract's check command (also verify-first).
 *
 * - Under a refusal (the switch names an unknown layer, which refuses on every platform) each site
 *   answers as section 8.7 of the specification says and the command it would have run left no
 *   witness.
 * - With a test context and a real shell, the child sees the sandbox as its home, its scratch
 *   folder exists, and the harness's own keys do not reach it. On Windows these cases switch the
 *   low-integrity layer off (`lowil`): vitest runs on Node, which cannot lower a token; the
 *   Windows layer itself is proven under Bun by containmentLauncher.test.ts.
 * - The Git tool's environment reaches git through the vitest Bun.spawn shim
 *   (setup/bunShim.ts), so `config --global` names the sandbox's own .gitconfig.
 *
 * Works only inside its own mkdtemp folder; the context is a test context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LAUNCHER_UNAVAILABLE, refusalLayerOf, refusalText, setRunContainment, testContainment, type RunContainment,
} from '../../containment.js'
import { bashTool } from '../../tools/impl/bash.js'
import { gitTool } from '../../tools/impl/git.js'
import { applyPatchTool } from '../../tools/impl/applyPatch.js'
import { gitProbe, runCommandDetailed } from '../../tools/contractVerify.js'
import { runTests } from '../../bestOfN/sampler.js'
import { LSPManager } from '../../lsp/manager.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const WIN = process.platform === 'win32'
const SAVED = ['LOCALCODE_CONTAINMENT_OFF', 'LOCALCODE_MISSION_CHECK', 'TEMP', 'TMP', 'TMPDIR',
  'LOCALCODE_BEST_OF_N', 'LOCALCODE_BEST_OF_N_COUNT'] as const
let saved: Record<string, string | undefined> = {}
let dir: string
let mission: string
let ctx: RunContainment

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map(k => [k, process.env[k]]))
  delete process.env.LOCALCODE_CONTAINMENT_OFF
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cynco-contained-sites-')))
  mission = join(dir, 'mission')
  // The run's sandbox sits in a sandbox root of its own, as on a real machine: a mission folder beside
  // the run's sandbox, inside the folder all runs' sandboxes share, is a context the path check refuses (F242, S4).
  const runDir = join(dir, 'sandboxes', 'run')
  const sandbox = { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }
  for (const d of [mission, sandbox.home, sandbox.tmp, sandbox.scratch]) mkdirSync(d, { recursive: true })
  writeFileSync(join(sandbox.home, '.gitconfig'), '[user]\n\tname = sandbox-identity\n\temail = sandbox@localhost\n')
  ctx = testContainment({
    missionCwd: mission, sandbox, home: join(dir, 'realhome'),
    folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
  })
})

afterEach(() => {
  setRunContainment(null)
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  globalContract.clear()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** The refusal path: a context, and a switch word no layer has (refuses for a test context too). */
function refuseEverywhere(): string {
  setRunContainment(ctx)
  process.env.LOCALCODE_CONTAINMENT_OFF = 'no-such-layer'
  return refusalText('containment', 'LOCALCODE_CONTAINMENT_OFF names an unknown layer: no-such-layer')
}

/** A real shell under the context: on Windows the launcher layer is switched off (Node, not Bun). */
function containWithRealShell(): void {
  setRunContainment(ctx)
  if (WIN) process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
}

const norm = (p: string) => { const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s }
const inside = (p: string, root: string) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/')

const WITNESS = 'ran.txt'
const writeWitness = `node -e "require('fs').writeFileSync('${WITNESS}', 'x')"`

function gitInit(at: string): void {
  const g = (args: string[]) => spawnSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { cwd: at, encoding: 'utf-8' })
  expect(g(['init', '-q']).status).toBe(0)
  writeFileSync(join(at, 'f.txt'), 'x\n')
  expect(g(['add', 'f.txt']).status).toBe(0)
  expect(g(['commit', '-q', '-m', 'init']).status).toBe(0)
}

describe('a contained run whose launcher cannot run starts nothing (section 8.7)', () => {
  it('Bash: the refusal text, no exit code, no witness', async () => {
    const text = refuseEverywhere()
    const r = await bashTool.execute({ command: writeWitness }, mission)
    expect(r.isError).toBe(true)
    expect(r.output).toBe(text)
    expect(r.exitCode).toBeUndefined()
    expect(existsSync(join(mission, WITNESS))).toBe(false)
  })

  it('Git: the refusal text, and git did not run (no repository was made)', async () => {
    const text = refuseEverywhere()
    const r = await gitTool.execute({ subcommand: 'init' }, mission)
    expect(r.isError).toBe(true)
    expect(r.output).toBe(text)
    expect(existsSync(join(mission, '.git'))).toBe(false)
  })

  it('ApplyPatch: the refusal text, and no patch file was written', async () => {
    // os.tmpdir() reads these at call time, so the tool's patch file would land in this folder.
    const patchTmp = join(dir, 'patch-tmp')
    mkdirSync(patchTmp)
    process.env.TEMP = patchTmp; process.env.TMP = patchTmp; process.env.TMPDIR = patchTmp
    expect(tmpdir()).toBe(patchTmp)
    const text = refuseEverywhere()
    const r = await applyPatchTool.execute({ patch: 'not a patch\n', check: true }, mission)
    expect(r.isError).toBe(true)
    expect(r.output).toBe(text)
    expect(readdirSync(patchTmp)).toEqual([])
  })

  it('best-of-N runTests: refused, a zero score, nothing run', () => {
    const text = refuseEverywhere()
    const r = runTests(mission, { framework: 'pytest', command: writeWitness } as any)
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: text })
    expect(existsSync(join(mission, WITNESS))).toBe(false)
  })

  it('LSP diagnostics: none, one log line, and the compiler was not run', async () => {
    refuseEverywhere()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    writeFileSync(join(mission, 'x.py'), 'print(1)\n')
    const diags = await new LSPManager(mission).getDiagnostics(join(mission, 'x.py'))
    expect(diags).toEqual([])
    expect(log.mock.calls.filter(c => String(c[0]).startsWith('[lsp] diagnostics not run: Refused [containment]:'))).toHaveLength(1)
    expect(existsSync(join(mission, '__pycache__'))).toBe(false)
  })

  it('a contract check command (and verify-first): unrunnable, ms 0, the refusal as its tail, not run', async () => {
    const text = refuseEverywhere()
    const r = await runCommandDetailed(mission, writeWitness, 30_000)
    expect(r).toEqual({ outcome: 'unrunnable', ms: 0, tail: text })
    expect(refusalLayerOf(r.tail)).toBe('containment')
    expect(existsSync(join(mission, WITNESS))).toBe(false)
  })

  it.skipIf(!WIN)('Bash on Windows with a context and no switch: the launcher is unavailable under Node', async () => {
    setRunContainment(ctx)
    const r = await bashTool.execute({ command: writeWitness }, mission)
    expect(r.isError).toBe(true)
    expect(r.output).toBe(refusalText('containment', LAUNCHER_UNAVAILABLE('not Bun')))
    expect(existsSync(join(mission, WITNESS))).toBe(false)
  })
})

describe('with a context, the child sees the sandbox', () => {
  it('Bash: the shell\'s home and CYNCO_SCRATCH are inside the sandbox, and the scratch folder exists', async () => {
    containWithRealShell()
    const command = getShellInfo().isPowerShell
      ? 'Write-Output "U=$env:USERPROFILE"; Write-Output "H=$HOME"; Write-Output "S=$env:CYNCO_SCRATCH"'
      : 'echo "H=$HOME"; echo "S=$CYNCO_SCRATCH"'
    const r = await bashTool.execute({ command }, mission)
    expect(r.isError, r.output).toBe(false)
    const field = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(r.output)?.[1] ?? '').trim()
    if (getShellInfo().isPowerShell) expect(inside(field('U'), ctx.sandbox.root), r.output).toBe(true)
    expect(inside(field('H'), ctx.sandbox.root), r.output).toBe(true)
    expect(norm(field('S'))).toBe(norm(ctx.sandbox.scratch))
    expect(existsSync(field('S'))).toBe(true)
  }, 60_000)

  it('Bash with a null context: the home the shell prints is the process\'s own', async () => {
    const command = getShellInfo().isPowerShell ? 'Write-Output "U=$env:USERPROFILE"' : 'echo "U=$HOME"'
    const r = await bashTool.execute({ command }, mission)
    expect(r.isError, r.output).toBe(false)
    const own = WIN ? (process.env.USERPROFILE ?? homedir()) : (process.env.HOME ?? homedir())
    expect(norm((/^U=(.*)$/m.exec(r.output)?.[1] ?? ''))).toBe(norm(own))
  }, 60_000)

  it('Git tool: `config --global` reads the sandbox .gitconfig (the env reaches Bun.spawn)', async () => {
    containWithRealShell()
    const r = await gitTool.execute({ subcommand: 'config', args: '--global --list --show-origin' }, mission)
    expect(r.isError, r.output).toBe(false)
    expect(r.output).toContain('user.name=sandbox-identity')
    // git quotes a path holding backslashes and doubles each one: "C:\\Users\\...\\.gitconfig"
    const quoted = /^file:(.*?)\tuser\.name=sandbox-identity$/m.exec(r.output)?.[1] ?? ''
    const origin = quoted.replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\')
    expect(norm(origin)).toBe(norm(join(ctx.sandbox.home, '.gitconfig')))
  }, 60_000)

  it('runCommandDetailed: prints the sandbox home; LOCALCODE_MISSION_CHECK set in the engine is not visible', async () => {
    containWithRealShell()
    process.env.LOCALCODE_MISSION_CHECK = 'harness-only-check'
    const command = getShellInfo().isPowerShell
      ? 'Write-Output "H=$env:USERPROFILE M=[$env:LOCALCODE_MISSION_CHECK]"'
      : 'echo "H=$HOME M=[$LOCALCODE_MISSION_CHECK]"'
    const r = await runCommandDetailed(mission, command, 60_000)
    expect(r.outcome, r.tail).toBe('passed')
    const m = /H=(.*) M=\[(.*)\]/.exec(r.tail)
    expect(m, r.tail).not.toBeNull()
    expect(norm(m![1])).toBe(norm(ctx.sandbox.home))
    expect(m![2]).toBe('')
  }, 90_000)

  it('the contract\'s git reads answer from the repository in a contained run (harness git, not refused)', async () => {
    gitInit(mission)
    setRunContainment(ctx)
    const probe = gitProbe(mission)
    expect(await probe.head()).toMatch(/^[0-9a-f]{40}$/)
    expect(await probe.dirtyPaths()).toEqual([])
    writeFileSync(join(mission, 'f.txt'), 'changed\n')
    expect(await probe.dirtyPaths()).toEqual(['f.txt'])
  }, 60_000)
})

describe('the same sites with no context run as before', () => {
  it('a contract check command runs and passes', async () => {
    const r = await runCommandDetailed(mission, writeWitness, 60_000)
    expect(r.outcome, r.tail).toBe('passed')
    expect(existsSync(join(mission, WITNESS))).toBe(true)
  }, 90_000)

  it('ApplyPatch reaches git apply', async () => {
    const r = await applyPatchTool.execute({ patch: 'not a patch\n', check: true }, mission)
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBeNull()
    expect(r.output).toMatch(/^Patch failed:/)
  })

  it('best-of-N runTests runs the command and is not refused', () => {
    const r = runTests(mission, { framework: 'pytest', command: writeWitness } as any)
    expect(r.refused).toBeUndefined()
    expect(existsSync(join(mission, WITNESS))).toBe(true)
  })
})

// ─── Best-of-N: a refused test run applies no candidate (beside bridge/bestOfNCleanup.test.ts) ───

function loopConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let idx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { const gen = responses[idx++]; if (gen) yield* gen() },
  } as Provider
}

function done(): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

describe('best-of-N with a refused test run', () => {
  it('scores no candidate, applies none, says why, and its worktree lived in the sandbox scratch folder', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '1'
    globalContract.clear()
    writeFileSync(join(mission, 'package.json'), JSON.stringify({ name: 'bon-refused', private: true, scripts: { test: 'node -e "0"' } }))
    writeFileSync(join(mission, '.gitignore'), '.cynco*\n.cynco/\n')
    execSync('git -c user.name=t -c user.email=t@t -c core.autocrlf=false -c commit.gpgsign=false init -q', { cwd: mission, stdio: 'pipe' })
    execSync('git -c user.name=t -c user.email=t@t -c core.autocrlf=false -c commit.gpgsign=false add -A', { cwd: mission, stdio: 'pipe' })
    execSync('git -c user.name=t -c user.email=t@t -c core.autocrlf=false -c commit.gpgsign=false commit -q -m base', { cwd: mission, stdio: 'pipe' })
    refuseEverywhere()

    let loop: ConversationLoop | null = null
    let candidateTree = ''
    const write = function* (): Generator<StreamEvent> {
      candidateTree = (loop as any).executor.cwd as string
      yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Write', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(candidateTree, 'g.txt'), content: 'y\n' }) } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
    const frames: any[] = []
    const log = vi.spyOn(console, 'log')
    loop = new ConversationLoop({
      cwd: mission, config: loopConfig(),
      // candidate: write + done; the single-pass fallback: done
      provider: mockProvider([write, done(), done()]),
      emit: (e: any) => { frames.push(e) },
      allowedTools: ['Read', 'Write'],
    })
    await loop.handleUserMessage('write g.txt')

    expect(candidateTree).toMatch(/cynco-bestofn-/)
    expect(inside(candidateTree, ctx.sandbox.scratch)).toBe(true)
    expect(frames.some(f => f.type === 'bestOfN.candidate')).toBe(false)
    expect(frames.some(f => f.type === 'bestOfN.selected')).toBe(false)
    const text = frames.filter(f => f.type === 'stream.token').map(f => f.text).join('')
    expect(text).toContain('**Best-of-N:** the candidates\' tests could not be run, so no candidate was applied.')
    expect(log.mock.calls.some(c => String(c[0]).startsWith('[bestOfN] tests not run: Refused [containment]:'))).toBe(true)
    // The candidate's write never reached the main tree, and its worktree is gone.
    expect(existsSync(join(mission, 'g.txt'))).toBe(false)
    expect(existsSync(candidateTree)).toBe(false)
  }, 120_000)
})
