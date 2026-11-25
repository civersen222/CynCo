import { execFile, execSync } from 'child_process'
import { ContainmentRefusal, containedCommand, launcherFaultOf, refusalReasonOf, refusalText, toolExec, toolSpawnRefusal } from '../containment.js'
import { toolAudit, containmentFault } from '../audit/toolAudit.js'
import { presenceTripwireConfirmed } from '../integrity.js'
import { ownedExec, ownProcessTree, type OwnedExecEnd } from '../processTree.js'
import { longCommandRefusal } from '../tools/impl/bash.js'
import type { Diagnostic, LSPServerConfig } from './types.js'

/** A diagnostics command: shell text (`npx` needs the shell on Windows), or a program and its arguments. */
type DiagCommand = { shell: string } | { file: string; args: string[] }

/** What a diagnostics command left when it failed: its status and both streams. */
type DiagFailure = { status: number | null; stdout: string; stderr: string }

const KNOWN_SERVERS: LSPServerConfig[] = [
  { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'], fileExtensions: ['.ts', '.tsx', '.js', '.jsx'] },
  { language: 'python', command: 'pylsp', args: [], fileExtensions: ['.py'] },
  { language: 'sql', command: 'sql-language-server', args: ['up', '--method', 'stdio'], fileExtensions: ['.sql'] },
  { language: 'rust', command: 'rust-analyzer', args: [], fileExtensions: ['.rs'] },
  { language: 'go', command: 'gopls', args: ['serve'], fileExtensions: ['.go'] },
  { language: 'c', command: 'clangd', args: [], fileExtensions: ['.c', '.cpp', '.h', '.hpp'] },
]

export class LSPManager {
  private cwd: string
  private diagnosticsCache = new Map<string, Diagnostic[]>()
  /** Programs a diagnostics command could not start (ENOENT), each said once in the log. */
  private unstartable = new Set<string>()

  constructor(cwd: string) {
    this.cwd = cwd
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
    this.diagnosticsCache.clear()
  }

  detectAvailable(): LSPServerConfig[] {
    return KNOWN_SERVERS.filter(s => {
      try {
        // Not contained: it runs in the engine's own folder and starts no workspace code.
        execSync(`which ${s.command} 2>/dev/null || where ${s.command} 2>NUL`, { encoding: 'utf-8', stdio: 'pipe' })
        return true
      } catch { return false }
    })
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    // Quick diagnostics via compiler commands rather than full LSP protocol
    const ext = filePath.split('.').pop() ?? ''
    try {
      if (['.ts', '.tsx'].includes(`.${ext}`)) {
        return await this.getTypeScriptDiagnostics(filePath)
      }
      if (ext === 'py') {
        return await this.getPythonDiagnostics(filePath)
      }
    } catch {}
    return []
  }

  /**
   * One diagnostics command: workspace code, so contained in an unattended run and recorded by the
   * tool-call audit before it starts (F242). `ran: false` means it was not started (a containment
   * refusal, or a record that could not be written), which yields no diagnostics.
   */
  private async runDiag(cmd: DiagCommand, timeout: number): Promise<{ ran: boolean; err: DiagFailure | null }> {
    // The record names the program and its arguments as they are passed; the file is one argument,
    // never shell text.
    const command = 'shell' in cmd ? cmd.shell : [cmd.file, ...cmd.args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
    // F242 (NOW.md, the bypass sites): diagnostics start outside the executor, so they ask the
    // presence tripwire themselves. After a loss in a contained engine they give none and say why.
    const lost = await presenceTripwireConfirmed()
    if (lost) {
      const text = refusalText('integrity', lost)
      toolAudit()?.refused({ src: 'lsp', by: 'site', input: { command }, cwd: this.cwd, layer: 'integrity', reason: text })
      console.log('[lsp] diagnostics not run: ' + text)
      containmentFault('integrity', lost)
      return { ran: false, err: null }
    }
    // Wave 19b (`longCommandRefusal`): a command one Windows command line cannot carry made the spawn
    // throw, and one that starts Git's bash or sh with more than about 8,190 characters ran cut short.
    // Neither is started; there are no diagnostics, and it is no containment fault.
    const tooLong = longCommandRefusal(command, command)
    if (tooLong) {
      toolAudit()?.refused({ src: 'lsp', by: 'site', input: { command }, cwd: this.cwd, reason: tooLong })
      console.log('[lsp] diagnostics not run: ' + tooLong)
      return { ran: false, err: null }
    }
    const audit = toolAudit()
    const started = audit ? audit.start({ src: 'lsp', command, cwd: this.cwd }) : null
    if (started && !started.ok) {
      console.error(`[lsp] diagnostics not run: ${started.reason}`)
      return Promise.resolve({ ran: false, err: null })
    }
    const t0 = Date.now()
    // A refusal of the box is a containment fault (it ends a contained run); any other reason a start
    // failed is said and costs the diagnostics only (check C4-8).
    const notRun = (message: string, refused = true) => {
      if (audit && started) audit.end(started.call, { isError: true, exitCode: null, ms: Date.now() - t0, output: message })
      console.log('[lsp] diagnostics not run: ' + message)
      if (refused) containmentFault('containment', refusalReasonOf(message))
      return { ran: false, err: null }
    }
    const program = 'shell' in cmd ? 'the shell' : cmd.file
    // The tree is owned from the moment the root exists and ended on the command's own cap, with a
    // two-second grace, and on an output overrun (`ownedExec`, engine/processTree.ts): a spawn's own
    // timeout ended the root alone and left what it had started running (NOW.md, 2026-11-24; F201,
    // F210). A command that ends on its own gives the handle back.
    let r: OwnedExecEnd
    // The program form's launcher seal (undefined when no launcher started it); null for the shell form.
    let file: { seal: string | undefined } | null = null
    try {
      if ('shell' in cmd) {
        r = await ownedExec(callback => toolExec(cmd.shell, { cwd: this.cwd, encoding: 'utf-8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, callback),
          { capMs: timeout, own: ownProcessTree })
      } else {
        // A program and its arguments, through the same containment as toolExec: the launcher's
        // `--exec` form in a contained run on Windows, the program itself otherwise.
        const refusal = toolSpawnRefusal()
        if (refusal) return notRun(refusal)
        const c = containedCommand({ file: cmd.file, args: cmd.args }, { cwd: this.cwd })
        file = { seal: c.seal }
        r = await ownedExec(callback => execFile(c.file, c.args, { cwd: c.cwd, env: c.env, encoding: 'utf-8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, callback),
          { capMs: timeout, own: ownProcessTree })
      }
    } catch (e) {
      return e instanceof ContainmentRefusal ? notRun(e.message) : notRun((e as Error).message, false)
    }
    const { err, stdout, stderr, timedOut, overran } = r
    if (err instanceof ContainmentRefusal) return notRun(err.message)
    if (file !== null && err && !timedOut) {
      const status = typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null
      const fault = launcherFaultOf(status, stderr, file.seal)
      if (fault) return notRun(fault.text)
    }
    // The program could not be started at all (check C4-9: a python on PATH that is a .cmd or .bat
    // shim, which a start without a shell cannot run). Said once per program, not per save.
    if (!timedOut && (err as { code?: unknown } | null)?.code === 'ENOENT') {
      if (audit && started) audit.end(started.call, { isError: true, exitCode: null, ms: Date.now() - t0, output: (err as Error).message })
      if (!this.unstartable.has(program)) {
        this.unstartable.add(program)
        console.log(`[lsp] ${program} could not be started (${(err as Error).message}); no diagnostics from it`)
      }
      return { ran: false, err: null }
    }
    if (!err && !timedOut) {
      if (audit && started) audit.end(started.call, { isError: false, exitCode: 0, ms: Date.now() - t0, output: '' })
      return { ran: true, err: null }
    }
    const code = (err as { code?: unknown } | null)?.code
    const status = !timedOut && typeof code === 'number' ? code : null
    if (audit && started) audit.end(started.call, { isError: true, exitCode: status, ms: Date.now() - t0, output: stdout + stderr })
    // A command cut at its cap said nothing about the file: what it printed is not a diagnostic.
    if (timedOut) {
      console.log(`[lsp] diagnostics cut at their cap of ${timeout} ms; no diagnostics`)
      return { ran: true, err: null }
    }
    // tsc's output that overran is still TypeScript lines, and the ones read are diagnostics: a
    // build broken widely enough to print 8 MiB must not read as clean (wave 19, check C4-3). The
    // line the overrun cut is dropped: only whole lines are read.
    if (overran && 'shell' in cmd) {
      console.log('[lsp] diagnostics output overran its buffer of 8 MiB; the errors read before it are given')
      const whole = (s: string) => s.slice(0, s.lastIndexOf('\n') + 1)
      return { ran: true, err: { status: null, stdout: whole(stdout), stderr: whole(stderr) } }
    }
    // py_compile's did not say anything about the file: exec ended it part way, and the part it read
    // was shown as a Python error (wave 15c, found by check B4-7's overrun case).
    if (overran) {
      console.log('[lsp] diagnostics output overran its buffer of 8 MiB; no diagnostics')
      return { ran: true, err: null }
    }
    return { ran: true, err: { status, stdout, stderr } }
  }

  private async getTypeScriptDiagnostics(filePath: string): Promise<Diagnostic[]> {
    // Workspace code (a local tsc), so contained in an unattended run (F242).
    const r = await this.runDiag({ shell: `npx tsc --noEmit --pretty false 2>&1` }, 15000)
    if (!r.err) return [] // No errors, or not run
    return this.parseTscOutput(r.err.stdout)
  }

  private parseTscOutput(output: string): Diagnostic[] {
    const diags: Diagnostic[] = []
    const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm
    let match
    while ((match = regex.exec(output)) !== null) {
      diags.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4] as 'error' | 'warning',
        message: match[5],
        source: 'typescript',
      })
    }
    return diags
  }

  private async getPythonDiagnostics(filePath: string): Promise<Diagnostic[]> {
    // Workspace code (a py_compile.py the run planted would be imported), so contained (F242). The
    // file is one argument, never shell text (NOW.md, 2026-11-24): inside a shell string cmd read a
    // `%NAME%` in the file name as a variable, and a POSIX shell a `$(...)` or a quote. Without the
    // shell's `2>&1` py_compile's error is on stderr, which is where it is read; with it, stderr was
    // an empty string, `?? stdout` never reached the merged text, and no Python error was ever shown.
    const r = await this.runDiag({ file: 'python', args: ['-m', 'py_compile', filePath] }, 10000)
    if (!r.err) return []
    const output = (r.err.stderr || r.err.stdout || '').trim()
    if (output) {
      return [{ file: filePath, line: 0, column: 0, severity: 'error', message: output.slice(0, 500), source: 'python' }]
    }
    return []
  }

  formatForModel(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return ''
    const lines = ['[Compiler Diagnostics]']
    for (const d of diagnostics.slice(0, 20)) {
      lines.push(`  [${d.severity}] ${d.file}:${d.line}:${d.column} — ${d.message}`)
    }
    if (diagnostics.length > 20) lines.push(`  ... and ${diagnostics.length - 20} more`)
    return lines.join('\n')
  }
}
