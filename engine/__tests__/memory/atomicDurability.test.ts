import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readLedger, writeLedger } from '../../memory/ledger.js'
import { writeHandoff, readHandoff } from '../../memory/handoff.js'

describe('ledger + handoff durable writes', () => {
  let dir: string
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('writeLedger persists via atomic write with no temp residue', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    const ledger = await readLedger(dir, 'proj')
    ledger.current_focus = 'phase5'
    await writeLedger(ledger, dir)
    const reread = await readLedger(dir, 'proj')
    expect(reread.current_focus).toBe('phase5')
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })

  it('writeHandoff persists via atomic write with no temp residue', async () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-'))
    const p = await writeHandoff({ goal: 'g', now: 'n', status: 'in_progress' } as any, dir, 'topic')
    const h = await readHandoff(p)
    expect(h.goal).toBe('g')
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })
})
