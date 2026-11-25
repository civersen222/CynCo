// scripts/cynco-containment-setup.ps1, `Get-LowLabel` (NOW.md:98): the setup script reads a folder's
// integrity label from its security descriptor in SDDL, not from the English words icacls prints
// (`Mandatory Label\Low Mandatory Level`, which Windows translates). The function is taken from the
// script's own text and run by Windows PowerShell against folders this test makes in its own temp
// folder and labels with icacls; the test removes them. Windows only (there are no labels elsewhere).
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'
const SYS = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const PS = join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const ICACLS = join(SYS, 'icacls.exe')
// The script is kept with CRLF line ends; read as lines.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cynco-containment-setup.ps1'), 'utf-8').replace(/\r\n/g, '\n')

/** The Add-Type block and the function, exactly as the script holds them. */
function labelReader() {
  const start = src.indexOf("if (-not ('CyncoSetupLabel' -as [type])) {")
  const fn = src.indexOf('function Get-LowLabel([string]$p) {')
  expect(start, 'the script has no CyncoSetupLabel block').toBeGreaterThan(-1)
  expect(fn, 'the script has no Get-LowLabel').toBeGreaterThan(start)
  const end = src.indexOf('\n}\n', fn)
  expect(end).toBeGreaterThan(fn)
  return src.slice(start, end + 3)
}

const made = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

describe.skipIf(!WIN)('Get-LowLabel reads the label from SDDL', () => {
  it('a Low label folders inherit, a plain Low label, a medium label, none, and a path that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-setup-label-'))
    made.push(dir)
    const p = { inheritable: join(dir, 'low-inheritable'), plain: join(dir, 'low-plain'), medium: join(dir, 'medium'), none: join(dir, 'none'), child: join(dir, 'low-inheritable', 'child') }
    for (const d of Object.values(p)) mkdirSync(d, { recursive: true })
    const label = (path, level) => {
      const r = spawnSync(ICACLS, [path, '/setintegritylevel', level], { encoding: 'utf-8', windowsHide: true })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    }
    label(p.inheritable, '(OI)(CI)L')
    label(p.plain, 'L')
    label(p.medium, '(OI)(CI)M')
    const script = join(dir, 'read.ps1')
    const ask = [...Object.entries(p), ['missing', join(dir, 'missing')]]
    writeFileSync(script, [
      labelReader(),
      ...ask.map(([k, v]) => `$r = Get-LowLabel '${v.replace(/'/g, "''")}'; if ($null -eq $r) { $r = '(null)' }; Write-Output "${k}=$r"`),
    ].join('\n'))
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf-8', windowsHide: true, timeout: 120_000 })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    const said = Object.fromEntries(r.stdout.split(/\r?\n/).map(l => /^(\w+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]))
    expect(said).toEqual({
      inheritable: 'low-inheritable', plain: 'low', medium: 'not-low', none: 'not-low',
      // A folder made under a folder labelled (OI)(CI) low inherits the label, and passes it on.
      child: 'low-inheritable',
      missing: '(null)',
    })
    for (const d of [p.inheritable, p.plain]) label(d, '(OI)(CI)M')
    expect(existsSync(dir)).toBe(true)
  }, 180_000)

  it('the folder checks use it, and no longer read icacls words', () => {
    expect(src).toContain('$label = Get-LowLabel $full')
    expect(src).toContain('$plabel = Get-LowLabel $parent')
    expect(src).not.toMatch(/Mandatory Label\\\\Low/)
  })
})
