/**
 * engine/lowIntegrityLauncher.ts, `shellStart` (NOW.md:261): a contained PowerShell is started with
 * `-NoProfile -NonInteractive -Command`, so a PowerShell profile under the owner's real Documents
 * never runs in a contained call and no prompt waits for a person. Pure; the live reading (the
 * command line a contained PowerShell child sees) is `containmentBoxCore.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { shellStart } from '../lowIntegrityLauncher.js'

describe('shellStart', () => {
  it('Windows PowerShell and pwsh, by any path or case: an explicit argv with -NoProfile -NonInteractive -Command', () => {
    const cmd = `Write-Output 'a "b"'; exit 3`
    for (const shell of [
      'powershell.exe', 'powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:/Windows/System32/WindowsPowerShell/v1.0/PowerShell.EXE', 'pwsh', 'pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ]) {
      expect(shellStart(shell, cmd), shell).toEqual({ file: shell, args: ['-NoProfile', '-NonInteractive', '-Command', cmd] })
    }
    // A quoted path is started by the path inside the quotes (an argv spawn does not take the quotes off).
    expect(shellStart('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', cmd).file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('every other shell, and the empty slot, as before: the command through `shell:`', () => {
    expect(shellStart('', 'echo hi')).toEqual({ file: 'echo hi', args: [], shell: true })
    expect(shellStart('cmd.exe', 'echo hi')).toEqual({ file: 'echo hi', args: [], shell: 'cmd.exe' })
    expect(shellStart('C:\\Program Files\\Git\\bin\\bash.exe', 'echo hi')).toEqual({ file: 'echo hi', args: [], shell: 'C:\\Program Files\\Git\\bin\\bash.exe' })
    // A name that only contains the word is not PowerShell.
    expect(shellStart('C:\\tools\\mypowershell.exe', 'x')).toEqual({ file: 'x', args: [], shell: 'C:\\tools\\mypowershell.exe' })
    expect(shellStart('C:\\tools\\powershell.exe.bak', 'x')).toEqual({ file: 'x', args: [], shell: 'C:\\tools\\powershell.exe.bak' })
  })
})
