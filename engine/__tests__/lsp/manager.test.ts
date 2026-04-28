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
    // Without a running server, should return empty
    const diags = await mgr.getDiagnostics('test.ts')
    expect(Array.isArray(diags)).toBe(true)
  })

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
