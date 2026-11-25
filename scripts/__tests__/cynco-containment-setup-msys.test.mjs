// scripts/cynco-containment-setup.ps1, the copy of Git's Unix tools (B1, wave 19): `Get-MsysCopyState` and
// `Copy-MsysRuntime`, taken from the script's own text and run by Windows PowerShell against a fake installed
// Git and a target folder this test makes in its own temp folder (never C:\cynco-msys, which the owner makes
// once by hand). The test removes what it made, the junction as an entry first. Windows only.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cynco-containment-setup.ps1'), 'utf-8').replace(/\r\n/g, '\n')

/** The label reader and the copy step, exactly as the script holds them. */
function step() {
  const label = src.slice(src.indexOf("if (-not ('CyncoSetupLabel' -as [type])) {"), src.indexOf('\n}\n', src.indexOf('function Get-LowLabel([string]$p) {')) + 3)
  const start = src.indexOf("$MsysManifestName = 'cynco-msys.manifest.json'")
  const fn = src.indexOf('function Copy-MsysRuntime([string]$gitRoot, [string]$target) {')
  expect(start, 'the script has no copy step').toBeGreaterThan(-1)
  expect(fn).toBeGreaterThan(start)
  return `${label}\n${src.slice(start, src.indexOf('\n}\n', fn) + 3)}`
}

const made = []
const links = []
afterAll(() => {
  for (const l of links) { try { rmdirSync(l) } catch (e) { console.log(`[setup-msys] the junction ${l} could not be removed as an entry: ${e.message}`) } }
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const sha = (s) => createHash('sha256').update(s).digest('hex')

function ps(body) {
  const dir = made[0]
  const script = join(dir, `run-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
  writeFileSync(script, `$ErrorActionPreference = 'Stop'\n${step()}\n${body}\n`)
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf-8', windowsHide: true, timeout: 120_000, cwd: dir })
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  return r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

describe.skipIf(!WIN)('the copy of Git\'s Unix tools (setup step, against a temp target)', () => {
  it('copies usr\\bin, etc, dev and tmp, never a link; writes the manifest; a second run copies nothing; a Git update makes it stale and a run refreshes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-setup-msys-'))
    made.push(dir)
    const git = join(dir, 'Git'), target = join(dir, 'copy'), outside = join(dir, 'outside')
    for (const d of [['usr', 'bin', 'sub'], ['etc'], ['dev'], ['tmp'], ['mingw64']]) mkdirSync(join(git, ...d), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'owner.txt'), 'the owner\'s')
    writeFileSync(join(git, 'usr', 'bin', 'bash.exe'), 'bash')
    writeFileSync(join(git, 'usr', 'bin', 'msys-2.0.dll'), 'v1')
    writeFileSync(join(git, 'usr', 'bin', 'sub', 'x.txt'), 'x')
    writeFileSync(join(git, 'etc', 'fstab'), 'fstab')
    writeFileSync(join(git, 'mingw64', 'not-copied.txt'), 'x')
    const lnk = join(git, 'usr', 'bin', 'lnk')
    symlinkSync(outside, lnk, 'junction')
    links.push(lnk)
    const q = (p) => `'${p.replace(/'/g, "''")}'`
    const out = ps(`Get-MsysCopyState ${q(git)} ${q(target)}; Copy-MsysRuntime ${q(git)} ${q(target)}; Get-MsysCopyState ${q(git)} ${q(target)}; Copy-MsysRuntime ${q(git)} ${q(target)}`)
    expect(out[0]).toBe('missing')
    expect(out[1]).toBe(`made ${target} (4 files, msys-2.0.dll ${sha('v1')})`)
    expect(out[2]).toBe('current')
    expect(out[3]).toBe(`made ${target} is current (nothing copied)`)
    for (const f of [['usr', 'bin', 'bash.exe'], ['usr', 'bin', 'sub', 'x.txt'], ['etc', 'fstab']]) expect(existsSync(join(target, ...f)), f.join('/')).toBe(true)
    expect(existsSync(join(target, 'usr', 'bin', 'lnk')), 'the junction is not copied').toBe(false)
    expect(existsSync(join(target, 'mingw64'))).toBe(false)
    expect(JSON.parse(readFileSync(join(target, 'cynco-msys.manifest.json'), 'utf-8'))).toMatchObject({ dllSha256: sha('v1'), files: 4, source: git })
    writeFileSync(join(git, 'usr', 'bin', 'msys-2.0.dll'), 'v2')
    const again = ps(`Get-MsysCopyState ${q(git)} ${q(target)}; Copy-MsysRuntime ${q(git)} ${q(target)}; Get-MsysCopyState ${q(git)} ${q(target)}`)
    expect(again).toEqual(['stale', `made ${target} (4 files, msys-2.0.dll ${sha('v2')})`, 'current'])
    expect(readFileSync(join(outside, 'owner.txt'), 'utf-8')).toBe('the owner\'s')
  }, 180_000)

  it('a folder it did not make (files, no manifest) is refused, and nothing is written into it', () => {
    const dir = made[0] ?? mkdtempSync(join(tmpdir(), 'cynco-setup-msys-'))
    if (!made.includes(dir)) made.push(dir)
    const git = join(dir, 'Git2'), target = join(dir, 'theirs')
    mkdirSync(join(git, 'usr', 'bin'), { recursive: true })
    writeFileSync(join(git, 'usr', 'bin', 'msys-2.0.dll'), 'v1')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const q = (p) => `'${p.replace(/'/g, "''")}'`
    expect(ps(`Get-MsysCopyState ${q(git)} ${q(target)}; Copy-MsysRuntime ${q(git)} ${q(target)}`)).toEqual([
      'foreign', `STOP ${target} holds files and no cynco-msys.manifest.json, so this script did not make it; name another folder with -MsysDir`,
    ])
    expect(existsSync(join(target, 'usr'))).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep')
  }, 120_000)
})
