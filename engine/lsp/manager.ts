import { execSync } from 'child_process'
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

  detectAvailable(): LSPServerConfig[] {
    return KNOWN_SERVERS.filter(s => {
      try {
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

  private getTypeScriptDiagnostics(filePath: string): Diagnostic[] {
    try {
      execSync(`npx tsc --noEmit --pretty false 2>&1`, { cwd: this.cwd, encoding: 'utf-8', timeout: 15000, stdio: 'pipe' })
      return [] // No errors
    } catch (err: any) {
      const output = err.stdout ?? ''
      return this.parseTscOutput(output)
    }
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
    try {
      execSync(`python -m py_compile "${filePath}" 2>&1`, { cwd: this.cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
      return []
    } catch (err: any) {
      const output = (err.stderr ?? err.stdout ?? '').trim()
      if (output) {
        return [{ file: filePath, line: 0, column: 0, severity: 'error', message: output.slice(0, 500), source: 'python' }]
      }
      return []
    }
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
