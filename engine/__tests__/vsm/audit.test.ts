import { describe, expect, it } from 'bun:test'
import { AuditMonitor } from '../../vsm/audit.js'

describe('AuditMonitor', () => {
  it('detects stuck after 3 turns without tools', () => {
    const audit = new AuditMonitor()
    audit.recordTurn(false)
    audit.recordTurn(false)
    audit.recordTurn(false)
    expect(audit.isStuck()).toBe(true)
  })

  it('resets stuck counter when tools are used', () => {
    const audit = new AuditMonitor()
    audit.recordTurn(false)
    audit.recordTurn(false)
    audit.recordTurn(true) // tool used — resets counter
    audit.recordTurn(false)
    expect(audit.isStuck()).toBe(false)
  })

  it('detects repetition when all recent responses are highly similar', () => {
    const audit = new AuditMonitor()
    const text = 'I cannot help with that request at this time please try again'
    audit.recordResponse(text)
    audit.recordResponse(text + ' please')
    audit.recordResponse(text)
    audit.recordResponse(text + ' please')
    expect(audit.isRepeating()).toBe(true)
  })

  it('does not flag varied responses as repeating', () => {
    const audit = new AuditMonitor()
    audit.recordResponse('Reading the file contents from disk')
    audit.recordResponse('Running the bash command to list directories')
    audit.recordResponse('Writing updated code to the target file')
    audit.recordResponse('Committing changes to git repository now')
    expect(audit.isRepeating()).toBe(false)
  })

  it('getSuggestion returns actionable text when stuck', () => {
    const audit = new AuditMonitor()
    audit.recordTurn(false)
    audit.recordTurn(false)
    audit.recordTurn(false)
    const suggestion = audit.getSuggestion()
    expect(suggestion.length).toBeGreaterThan(10)
    expect(suggestion).toContain('tools')
  })
})
