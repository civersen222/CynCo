import { execSync } from 'child_process'
import { ContainmentRefusal, refusalReasonOf, toolExecSync } from '../containment.js'
import { toolAudit, containmentFault } from '../audit/toolAudit.js'
import type { Diagnostic, LSPServerConfig } from './types.js'

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
        return this.getTypeScriptDiagnostics(filePath)
      }
      if (ext === 'py') {
        return this.getPythonDiagnostics(filePath)
      }
    } catch {}
    return []
  }

  /**
   * One diagnostics command: workspace code, so contained in an unattended run and recorded by the
   * tool-call audit before it starts (F242). `ran: false` means it was not started (a containment
   * refusal, or a record that could not be written), which yields no diagnostics.
   */
  private runDiag(command: string, timeout: number): { ran: boolean; err: any } {
    const audit = toolAudit()
    const started = audit ? audit.start({ src: 'lsp', command, cwd: this.cwd }) : null
    if (started && !started.ok) {
      console.error(`[lsp] diagnostics not run: ${started.reason}`)
      return { ran: false, err: null }
    }
    const t0 = Date.now()
    try {
      toolExecSync(command, { cwd: this.cwd, encoding: 'utf-8', timeout, stdio: 'pipe' })
      if (audit && started) audit.end(started.call, { isError: false, exitCode: 0, ms: Date.now() - t0, output: '' })
      return { ran: true, err: null }
    } catch (err: any) {
      if (err instanceof ContainmentRefusal) {
        if (audit && started) audit.end(started.call, { isError: true, exitCode: null, ms: Date.now() - t0, output: err.message })
        console.log('[lsp] diagnostics not run: ' + err.message)
        containmentFault('containment', refusalReasonOf(err.message))
        return { ran: false, err: null }
      }
      if (audit && started) {
        audit.end(started.call, {
          isError: true, exitCode: typeof err?.status === 'number' ? err.status : null, ms: Date.now() - t0,
          output: String(err?.stdout ?? '') + String(err?.stderr ?? ''),
        })
      }
      return { ran: true, err }
    }
  }

  private getTypeScriptDiagnostics(filePath: string): Diagnostic[] {
    // Workspace code (a local tsc), so contained in an unattended run (F242).
    const r = this.runDiag(`npx tsc --noEmit --pretty false 2>&1`, 15000)
    if (!r.err) return [] // No errors, or not run
    const output = r.err.stdout ?? ''
    return this.parseTscOutput(output)
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

  private getPythonDiagnostics(filePath: string): Diagnostic[] {
    // Workspace code (a py_compile.py the run planted would be imported), so contained (F242).
    const r = this.runDiag(`python -m py_compile "${filePath}" 2>&1`, 10000)
    if (!r.err) return []
    const output = (r.err.stderr ?? r.err.stdout ?? '').trim()
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
