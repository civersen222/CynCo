/**
 * F242, the in-process lane of the containment acceptance (06-acceptance-records.md, test T1).
 *
 * The attack catalog (scripts/cynco-containment-attacks.mjs) is handed here only to the protected-path
 * check, a pure function that cannot start a process, and to an executor that must refuse it before
 * anything starts. The one place a shell runs is case 17, with the listing-only twins. Every folder is
 * under this file's own temp root: a fake home, a mission repository, a sandbox. The context is a test
 * context from testContainment; no LOCALCODE_MISSION_* key is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LAUNCHER_UNAVAILABLE, refusalLayerOf, setRunContainment, testContainment, toolEnv, type RunContainment,
} from '../../containment.js'
import { checkProtectedPaths } from '../../tools/protectedPaths.js'
import { ToolExecutor } from '../../tools/executor.js'
import { bashTool } from '../../tools/impl/bash.js'
import { SECRET_REFUSAL, secretApprovalRefusal, secretPathOf } from '../../tools/secretPaths.js'
import { cyncoHome } from '../../paths.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { attacks, BYPASS_SPELLINGS, LEFT_BEHIND, TARGET_DOT_FOLDER, protectedFolderCalls } from '../../../scripts/cynco-containment-attacks.mjs'
import { buildFakeProfile, insideRoot, parseDry } from '../../../scripts/cynco-containment-acceptance.mjs'
import { bashExe } from '../../../scripts/cynco-spawn.mjs'

const WIN = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'cynco-attacks-'))
const nonce = 'a1b2c3d4'
const fake = buildFakeProfile(root, nonce)
const sandbox = { root: join(fake.sandboxRoot, 'run'), home: join(fake.sandboxRoot, 'run', 'home'), tmp: join(fake.sandboxRoot, 'run', 'tmp'), scratch: join(fake.sandboxRoot, 'run', 'scratch') }
for (const d of [sandbox.home, sandbox.tmp, sandbox.scratch]) mkdirSync(d, { recursive: true })
const DECOYS = [['.cynco', 'decoy.txt'], [TARGET_DOT_FOLDER, 'decoy.txt'], ['.decoy', 'a.txt']]
for (const [d, f] of DECOYS) { mkdirSync(join(sandbox.home, d), { recursive: true }); writeFileSync(join(sandbox.home, d, f), 'decoy\n') }
mkdirSync(join(root, 'outside'), { recursive: true })
writeFileSync(join(root, 'outside', 'gate.py'), "print('gate')\n")
const folders = { state: fake.state, models: fake.models, guard: fake.guard, audit: fake.audit }
const ctx: RunContainment = testContainment({ missionCwd: fake.mission, sandbox, home: fake.home, folders })
const authoringCtx: RunContainment = testContainment({ missionCwd: fake.a1, extraRoots: [fake.baseArchive], sandbox, home: fake.home, folders })
const linkMade: boolean = fake.linkError === null || fake.linkError === undefined
const GB = 'C:\\Program Files\\Git\\bin\\bash.exe'
const P = {
  home: fake.home, cwd: fake.mission, scratch: sandbox.scratch, linked: fake.linked, guard: fake.guard, audit: fake.audit,
  models: fake.models, sandboxRootOther: join(fake.sandboxRoot, 'acc-other-20260101T000000-0000'), nonce,
  dotEntries: readdirSync(fake.home).filter(n => n.startsWith('.')),
}
type Variant = { variant: string; label: string; form: string; call: { tool: string; input: Record<string, unknown> }; dry: { tool: string; input: { command: string } } | null; targets: string[] | null }
type Attack = { id: string; variants: (p: typeof P) => Variant[] }
const SHELLS = [
  { shell: 'powershell', python: 'python', gitBash: GB },
  { shell: 'powershell', python: 'python', gitBash: null },
  { shell: 'posix', python: 'python3', gitBash: null },
]
function allVariants(): Array<{ shell: string; attack: Attack; v: Variant }> {
  const out: Array<{ shell: string; attack: Attack; v: Variant }> = []
  for (const opts of SHELLS) for (const attack of attacks(opts) as Attack[]) for (const v of attack.variants(P)) out.push({ shell: opts.shell, attack, v })
  return out
}
const decide = (tool: string, input: Record<string, unknown>, cwd = fake.mission, c: RunContainment = ctx) => checkProtectedPaths(tool, input, cwd, c)
const approvals: string[] = []
const executor = (cwd = fake.mission, auditSrc?: 'tool' | 'subagent') => new ToolExecutor({
  cwd, approveAll: true, requestApproval: async (tool) => { approvals.push(tool); return true }, ...(auditSrc ? { auditSrc } : {}),
})

beforeAll(() => setRunContainment(ctx))
afterEach(() => {
  setRunContainment(ctx)
  delete process.env.LOCALCODE_CONTAINMENT_OFF
})
afterAll(() => {
  setRunContainment(null)
  for (const l of fake.links as string[]) {
    try { rmdirSync(l) } catch { try { unlinkSync(l) } catch (e) { console.log(`[test] the link ${l} could not be removed: ${(e as Error).message}`) } }
    expect(existsSync(l) || (() => { try { lstatSync(l); return true } catch { return false } })(), `the link ${l} is still there`).toBe(false)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('the attack catalog against the path check (decisions; F242, T1 cases 1 to 9)', () => {
  it('1. every mission-form variant, for PowerShell and for POSIX, is refused, and names what it refused', () => {
    const seen = allVariants().filter(x => x.v.form === 'mission')
    expect(seen.length).toBeGreaterThan(10)
    for (const { shell, attack, v } of seen) {
      const verdict = decide(v.call.tool, v.call.input)
      expect(verdict.kind, `${shell} ${attack.id} ${v.label}: ${JSON.stringify(v.call.input)}`).toBe('refuse')
      if (verdict.kind !== 'refuse') continue
      // The refusal names what it refused: the place in the fake home the spelling resolves to, or,
      // for a git setting that would start a program, the setting.
      const names = verdict.reason.toLowerCase().includes(fake.home.toLowerCase()) || /git setting core\.fsmonitor/.test(verdict.reason)
      expect(names, `${shell} ${attack.id} ${v.label} refused without naming its target: ${verdict.reason.slice(0, 300)}`).toBe(true)
    }
  })

  it('2. every literal variant is refused', () => {
    const seen = allVariants().filter(x => x.v.form === 'literal')
    expect(seen.length).toBeGreaterThan(10)
    for (const { shell, attack, v } of seen) {
      expect(decide(v.call.tool, v.call.input).kind, `${shell} ${attack.id} ${v.label}: ${JSON.stringify(v.call.input).slice(0, 200)}`).toBe('refuse')
    }
  })

  it('3. every bypass spelling is refused (they are never handed to anything that starts a process)', () => {
    for (const command of BYPASS_SPELLINGS as string[]) expect(decide('Bash', { command }).kind, command).toBe('refuse')
  })

  it('4. every call at the protected folders is refused, the read of the audit file included', () => {
    for (const shell of ['powershell', 'posix']) {
      for (const pc of protectedFolderCalls(P, { shell }) as Array<{ what: string; call: { tool: string; input: Record<string, unknown> } }>) {
        expect(decide(pc.call.tool, pc.call.input).kind, `${shell} ${pc.what}`).toBe('refuse')
      }
    }
  })

  it('5. the two tool-call plants of the eighth attack are refused', () => {
    const plants = LEFT_BEHIND.toolPlants(P) as Variant[]
    expect(plants.map(v => v.call.tool)).toEqual(['Write', 'Bash'])
    for (const v of plants) expect(decide(v.call.tool, v.call.input).kind, v.label).toBe('refuse')
  })

  it('6. honest work is allowed (the false-refusal pins), every listing-only twin included', () => {
    const honest: Array<[string, Record<string, unknown>]> = [
      ['Bash', { command: 'git status' }],
      ['Bash', { command: 'python -m pytest -q' }],
      ['Bash', { command: 'Remove-Item -Recurse -Force .\\build' }],
      ['Bash', { command: 'rm -rf ./build' }],
      ['Bash', { command: 'rm -rf "$CYNCO_SCRATCH"/t1' }],
      ['Write', { file_path: join(fake.mission, 'src', 'pkg', 'new.py'), content: 'x' }],
      ['Write', { file_path: join(sandbox.scratch, 'note.txt'), content: 'x' }],
      ['Read', { file_path: join(fake.home, '.gitconfig') }],
      ['Bash', { command: 'python -c "print(1)"' }],
      ['Bash', { command: '$env:SDL_VIDEODRIVER="dummy"; python -m pytest' }],
      ['Bash', { command: `python ${join(root, 'outside', 'gate.py')}` }],
    ]
    for (const [tool, input] of honest) expect(decide(tool, input).kind, `${tool} ${JSON.stringify(input)}`).not.toBe('refuse')
    for (const { shell, attack, v } of allVariants()) {
      if (!v.dry) continue
      expect(decide('Bash', v.dry.input).kind, `the ${shell} twin of ${attack.id} ${v.label}: ${v.dry.input.command}`).not.toBe('refuse')
    }
  })

  describe('7. spellings that collide with the attack spellings are allowed', () => {
    const ok = [
      'Set-Content -Path "$env:TEMP\\x.txt" -Value x', 'echo x > "$TMPDIR/x.txt"',
      'cd ~; Get-ChildItem', 'cd ~; ls',
      'Get-Content "$HOME\\.gitconfig"', 'cat "$HOME"/.gitconfig',
      'git commit -m "stop touching ~/.cynco"',
      "Select-String -Pattern '~/.cynco' -Path src\\pkg\\mod.py", "grep -n '~/.cynco' src/pkg/mod.py",
    ]
    for (const command of ok) it(command, () => expect(decide('Bash', { command }).kind, JSON.stringify(decide('Bash', { command })).slice(0, 300)).not.toBe('refuse'))
  })

  it('8. an authoring mission may write its own staging folder and nothing else of the state folder', () => {
    expect(decide('Write', { file_path: join(fake.a1, 'gate_a1.py'), content: 'x' }, fake.a1, authoringCtx).kind).not.toBe('refuse')
    expect(decide('Write', { file_path: join(fake.other, 'x.txt'), content: 'x' }, fake.a1, authoringCtx).kind).toBe('refuse')
    expect(decide('Write', { file_path: join(fake.heldout, 'x.txt'), content: 'x' }, fake.a1, authoringCtx).kind).toBe('refuse')
  })

  it('9. the roots do not follow the executor\'s folder: a relative Write from another folder is refused', () => {
    expect(decide('Write', { file_path: 'x.txt', content: 'x' }, join(root, 'outside')).kind).toBe('refuse')
    expect(Object.isFrozen(ctx)).toBe(true)
  })
})

describe('the executor refuses the catalog before anything starts (F242, T1 cases 10 to 19)', () => {
  const writeDot = () => (attacks({ shell: WIN ? 'powershell' : 'posix', python: 'python', gitBash: null }) as Attack[])
    .find(a => a.id === 'write-dot-folder')!.variants(P)

  it('10. the five file-tool variants answer a protected-path refusal; no file, no approval, approve-all does not open it', async () => {
    approvals.length = 0
    const ex = executor()
    for (const v of writeDot().filter(x => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'].includes(x.variant))) {
      const r = await ex.execute(v.call.tool, v.call.input)
      expect(r.isError, v.variant).toBe(true)
      expect(refusalLayerOf(r.output), `${v.variant}: ${r.output.slice(0, 200)}`).toBe('protected path')
      for (const t of v.targets ?? []) expect(existsSync(t), `${v.variant} created ${t}`).toBe(false)
    }
    expect(approvals).toEqual([])
  })

  it.skipIf(!linkMade)('11. a Write through a directory link is refused, and the refusal names the real landing path', async () => {
    const target = join(fake.linked, TARGET_DOT_FOLDER, `cynco-acceptance-${nonce}.txt`)
    const r = await executor().execute('Write', { file_path: target, content: 'x' })
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('protected path')
    expect(r.output.toLowerCase()).toContain(join(fake.home, TARGET_DOT_FOLDER).toLowerCase())
    expect(existsSync(join(fake.home, TARGET_DOT_FOLDER, `cynco-acceptance-${nonce}.txt`))).toBe(false)
  })
  if (!linkMade) console.log(`[test] case 11 skipped: ${fake.linkError}`)

  const ranFile = join(fake.home, TARGET_DOT_FOLDER, `ran-${nonce}.txt`)
  const createRan = WIN ? `New-Item -ItemType File -Path '${ranFile}'` : `touch '${ranFile}'`

  it('12. a Bash command that would create a file in the fake home is refused before the shell ran', async () => {
    const r = await executor().execute('Bash', { command: createRan })
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output), r.output.slice(0, 200)).toBe('protected path')
    expect(existsSync(ranFile)).toBe(false)
  })

  it('13. the Bash tool asked without the executor refuses the same command', async () => {
    const r = await bashTool.execute({ command: createRan }, fake.mission)
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('protected path')
    expect(existsSync(ranFile)).toBe(false)
  })

  it('14. a sub-agent\'s executor is held by the same context, and its refusal is recorded as the sub-agent\'s', async () => {
    const v = writeDot().find(x => x.variant === 'Write')!
    const sub = new ToolExecutor({ cwd: fake.mission, requestApproval: async () => true, approveAll: true, auditSrc: 'subagent' })
    const r = await sub.execute(v.call.tool, v.call.input)
    expect(refusalLayerOf(r.output)).toBe('protected path')
    const day = readdirSync(fake.audit).filter(n => n.endsWith('.jsonl'))
    const recs = day.flatMap(n => readFileSync(join(fake.audit, n), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)))
    const mine = recs.filter(x => x.kind === 'refused' && x.run === ctx.runId && JSON.stringify(x.input) === JSON.stringify(v.call.input) && x.src === 'subagent')
    expect(mine.length).toBe(1)
    expect(mine[0].layer).toBe('protected path')
  })

  it('15. the secret-path refusals still come first in a contained run', async () => {
    const ex = executor()
    const token = await ex.execute('Read', { file_path: join(cyncoHome(), 'tokens.json') })
    expect(token.output).toBe(SECRET_REFUSAL)
    const envFile = join(fake.mission, '.env')
    const hit = secretPathOf('Read', { file_path: envFile }, fake.mission)
    expect(hit).not.toBeNull()
    const env = await ex.execute('Read', { file_path: envFile })
    expect(env.output).toBe(secretApprovalRefusal(hit!))
    expect(refusalLayerOf(token.output)).toBeNull()
    expect(refusalLayerOf(env.output)).toBeNull()
  })

  it.skipIf(!WIN)('16. Windows under Node: with the path check off, the shell is refused by name (no launcher), and nothing is created', async () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'paths'
    const file = join(sandbox.scratch, `fail-closed-${nonce}.txt`)
    const r = await executor().execute('Bash', { command: `New-Item -ItemType File -Path '${file}'` })
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('containment')
    const head = LAUNCHER_UNAVAILABLE('x')
    expect(r.output).toContain(head.slice(0, head.indexOf('(')))
    expect(existsSync(file)).toBe(false)
  })

  describe('17. the overlay through a real shell, listing-only twins (both layers switched off for this test context)', () => {
    const info = getShellInfo()
    const hostShell = info.isPowerShell ? 'powershell' : 'posix'
    const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true }).status === 0
    const python = has('python', ['--version']) ? 'python' : has('python3', ['--version']) ? 'python3' : null
    let gitBash: string | null = null
    if (WIN) {
      try { gitBash = bashExe() } catch (e) { console.log(`[test] case 17: the Git Bash twins are skipped: ${(e as Error).message}`) }
    }
    if (!python) console.log('[test] case 17: the Python twins are skipped: python --version failed')
    const list = (attacks({ shell: hostShell, python: python ?? 'python', gitBash }) as Attack[])
      .flatMap(a => a.variants(P).filter(v => v.form === 'mission' && v.dry).map(v => ({ attack: a, v })))
    for (const { attack, v } of list) {
      const needsPython = v.dry!.input.command.includes('pathlib')
      it.skipIf(needsPython && !python)(`${attack.id} ${v.label}`, async () => {
        process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil,paths'
        const r = await bashTool.execute(v.dry!.input, fake.mission)
        // Rule S1': a twin counts only when it ran without an error.
        expect(r.isError, `${v.dry!.input.command}\n${r.output.slice(0, 400)}`).toBe(false)
        const d = parseDry(r.output)
        expect(d.resolved, `${v.dry!.input.command}\n${r.output.slice(0, 400)}`).toBe(true)
        for (const p of d.paths) {
          // A path boundary, not a string prefix: <run>\home2 is not inside <run>\home.
          expect(insideRoot(sandbox.home, p), `${attack.id} ${v.label} printed ${p}, outside the sandbox home ${sandbox.home}`).toBe(true)
        }
      }, 60_000)
    }
  })

  it('18. interactive runs are unchanged: with no context a Write outside any mission folder succeeds, and the home is the process\'s own', async () => {
    setRunContainment(null)
    const file = join(root, 'outside', `interactive-${nonce}.txt`)
    const r = await executor(join(root, 'outside')).execute('Write', { file_path: file, content: 'x' })
    expect(r.isError, r.output).toBe(false)
    expect(existsSync(file)).toBe(true)
    const key = WIN ? 'USERPROFILE' : 'HOME'
    expect(toolEnv(process.env, null)[key]).toBe(process.env[key])
  })

  it('19. the context does not leak: set, then null, and the next call is unrestricted', async () => {
    const file = join(root, 'outside', `leak-${nonce}.txt`)
    const refused = await executor(join(root, 'outside')).execute('Write', { file_path: file, content: 'x' })
    expect(refusalLayerOf(refused.output)).toBe('protected path')
    setRunContainment(null)
    const r = await executor(join(root, 'outside')).execute('Write', { file_path: file, content: 'x' })
    expect(r.isError, r.output).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
})
