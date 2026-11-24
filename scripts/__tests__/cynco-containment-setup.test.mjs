/**
 * scripts/cynco-containment-setup.ps1 is the one file of mission containment the owner runs by hand on
 * the real machine (F242). It creates the three folders no run may create and sets two user variables,
 * and only with -Apply. The suite cannot run it (it reads the machine's variables and scheduled tasks
 * and can set a user variable), so its text is pinned: the switch name it checks, the only commands
 * that change anything, their place after both gates, and the absence of anything that deletes,
 * copies, recurses or changes an access list. Patterns are word-bounded and anchored on command
 * position, so an ordinary word such as "model " does not match a ban.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { SWITCH_IN_UNATTENDED } from '../../engine/containment.js'
// The audit writer's marker name, pinned as a literal until the audit writer lands (S5): this test must
// not import a module a commit of S3, S4 and S6 does not carry (spec 05 section 4.7; review 2026-11-23).
const AUDIT_MARKER = '.cynco-audit'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cynco-containment-setup.ps1'), 'utf-8')
const at = (needle) => { const i = src.indexOf(needle); expect(i, `not found: ${needle}`).toBeGreaterThan(-1); return i }

// Any command position, not only a line's start (`if ($x) { New-Item ... }`), and the aliases.
const CHANGING = /(?:^|[;{|(])\s*(New-Item|ni|md|mkdir|sc|ac|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|Rename-Item|Clear-Content|Set-Acl|Set-ItemProperty|New-ItemProperty|Register-ScheduledTask|Unregister-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|Start-Process|Stop-Process|\[Environment\]::SetEnvironmentVariable|\[System\.IO\.(Directory|File)\]::(Move|Delete|Copy|Create\w*|Write\w*))\b/
const FOUR = [
  'New-Item -ItemType Directory -Path $d | Out-Null',
  'New-Item -ItemType File -Path $marker | Out-Null',
  "[Environment]::SetEnvironmentVariable('LOCALCODE_MODELS_DIR', $modelsTarget, 'User')",
  "[Environment]::SetEnvironmentVariable('LOCALCODE_UNPROTECTED_VOLUMES_OK', $ackTarget, 'User')",
]

describe('scripts/cynco-containment-setup.ps1', () => {
  it('checks the engine\'s own switch name (entry 5.M2)', () => {
    const lines = src.split(/\r?\n/).filter(l => /^\$SwitchVar = '/.test(l))
    expect(lines).toHaveLength(1)
    const name = /^\$SwitchVar = '([A-Z_]+)'$/.exec(lines[0].trim())?.[1]
    expect(name).toBeTruthy()
    expect(SWITCH_IN_UNATTENDED.startsWith(`${name} `)).toBe(true)
  })

  it('changes things with exactly four commands', () => {
    const changing = src.split(/\r?\n/).filter(l => CHANGING.test(l)).map(l => l.trim())
    expect(changing).toEqual(FOUR)
  })

  it('changes nothing without -Apply, and nothing past a blocking STOP', () => {
    const noApply = at('if (-not $Apply) {')
    const blocked = at("if ($script:blocking -gt 0) { Say 'STOP' 'nothing was changed: clear the STOP lines above first.'; exit 1 }")
    expect(noApply).toBeLessThan(blocked)
    for (const line of FOUR) expect(blocked, line).toBeLessThan(at(line))
    const between = src.slice(noApply, blocked)
    expect(between).toContain('exit 0')
    expect(between).toContain('exit 1')
  })

  it('has no command that deletes, copies, recurses, changes an access list or evaluates text', () => {
    expect(src).not.toMatch(/^\s*&?\s*(del|erase|rd|rmdir|robocopy|xcopy|takeown|setx|reg|mklink)\b/mi)
    expect(src).not.toMatch(/-Recurse\b/i)
    expect(src).not.toMatch(/\bicacls\b[^\n]*\s\/[A-Za-z]/)
    expect(src).not.toMatch(/Invoke-Expression|\biex\b/i)
  })

  it('names no drive but C:, and on C: only the containment folders', () => {
    expect(src).not.toMatch(/\b[ABD-Zabd-z]:\\/)
    const allowed = ['C:\\cynco-sandbox', 'C:\\cynco-guard', 'C:\\cynco-audit', 'C:\\cynco-models']
    for (const m of src.match(/C:\\[\w-]+/g) ?? []) expect(allowed, m).toContain(m)
    // The models folder is named only in the help text's example.
    const models = src.split(/\r?\n/).filter(l => l.includes('C:\\cynco-models'))
    expect(models).toHaveLength(1)
    expect(models[0]).toMatch(/^\s*scripts\\cynco-containment-setup\.ps1 -ModelsDir C:\\cynco-models -Apply/)
  })

  it('is ASCII only, so Windows PowerShell 5.1 reads it the same in every code page', () => {
    expect(src).toMatch(/^[\x09\x0A\x0D\x20-\x7E]*$/)
  })

  it('a daemon STOP makes the exit 1 but does not forbid -Apply', () => {
    const body = /function Stop-Daemon\([^)]*\) \{([^\n]*)\}/.exec(src)?.[1] ?? ''
    expect(body).toContain('$script:stops++')
    expect(body).not.toContain('$script:blocking')
    const here = /function Stop-Here\([^)]*\) \{([^\n]*)\}/.exec(src)?.[1] ?? ''
    expect(here).toContain('$script:blocking++')
  })

  it('writes the audit writer\'s marker name', () => {
    expect(src).toContain(`Join-Path $path '${AUDIT_MARKER}'`)
  })

  it('fails closed where the review of 2026-11-23 found it open', () => {
    // an elevated shell is a blocking STOP, before anything else is judged
    const elevated = at('[Security.Principal.WindowsBuiltInRole]::Administrator')
    expect(src.slice(elevated, elevated + 200)).toContain('Stop-Here')
    expect(elevated).toBeLessThan(at('# -- 1. The switch'))
    // an access list that cannot be read is a problem, and a missing leaf is judged by its parent's inheritable label
    expect(src.match(/\$LASTEXITCODE -ne 0/g)?.length).toBe(2)
    at("Mandatory Label\\\\Low Mandatory Level:[^\\r\\n]*\\(CI\\)")
    // the folders may not overlap
    at('overlap: each must be a folder of its own')
    // CYNCO_HOME, CYNCO_MISSIONS_DIR and the models folder as the logon tasks see them, not this terminal
    at("$homeSet = Get-SetVar 'CYNCO_HOME'")
    at("$missionsSet = Get-SetVar 'CYNCO_MISSIONS_DIR'")
    at("$modelsMachine = Get-MachineVar 'LOCALCODE_MODELS_DIR'")
    expect(src).not.toMatch(/\$env:CYNCO_(HOME|MISSIONS_DIR)/)
    // the value -Apply stores is the full form
    at('$ModelsDir = Get-Full $ModelsDir')
  })

  it('creates only the leaf folder, and never with -Force (which would hide an existing file)', () => {
    expect(src).not.toMatch(/New-Item[^\n]*-Force/)
    at("Create the parent yourself; this script creates one folder, never a tree.")
  })
})
