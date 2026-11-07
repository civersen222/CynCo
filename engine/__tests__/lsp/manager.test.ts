import { describe, expect, it } from 'bun:test'
import { LSPManager } from '../../lsp/manager.js'

describe('LSPManager', () => {
  it('detects available language servers', () => {
    const mgr = new LSPManager(process.cwd())
    const available = mgr.detectAvailable()
    // On this system, TypeScript server should be available
    expect(Array.isArray(available)).toBe(true)
  })

  it('collects diagnostics from file save', async () => {
    const mgr = new LSPManager(process.cwd())
    // Not a stub: for a .ts path this runs `npx tsc --noEmit` over the whole
    // repository (manager.ts getTypeScriptDiagnostics, 15 s cap), which takes
    // 5-7 s on a quiet machine and longer under the suite's load. The default
    // 5 s test timeout was the failure on Linux CI and the flake on Windows.
    const diags = await mgr.getDiagnostics('test.ts')
    expect(Array.isArray(diags)).toBe(true)
  }, 30000)

  it('formats diagnostics for model context', () => {
    const mgr = new LSPManager(process.cwd())
    const formatted = mgr.formatForModel([
      { file: 'src/app.ts', line: 10, column: 5, severity: 'error', message: "Cannot find name 'foo'", source: 'typescript' },
    ])
    expect(formatted).toContain('error')
    expect(formatted).toContain('app.ts')
    expect(formatted).toContain('foo')
  })
})
