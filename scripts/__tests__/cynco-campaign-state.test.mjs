import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CampaignState } from '../cynco-campaign-state.mjs'

describe('CampaignState', () => {
  it('starts fresh, saves atomically, reloads', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    const s = new CampaignState(dir); s.load()
    expect(s.state.waveCount).toBe(0)
    s.state.waveCount = 1; s.save()
    expect(existsSync(join(dir, 'state.json'))).toBe(true)
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false)
    const t = new CampaignState(dir); t.load()
    expect(t.state.waveCount).toBe(1)
  })
  it('backs up a corrupt state file and starts fresh', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    const s = new CampaignState(dir); s.load(); s.save()
    writeFileSync(join(dir, 'state.json'), '{truncated')
    const t = new CampaignState(dir); t.load()
    expect(t.state.waveCount).toBe(0)
    expect(existsSync(join(dir, 'state.json.corrupt'))).toBe(true)
  })
  // An appendFileSync that died mid-write truncates the LAST line. Losing every
  // earlier wave's promotion evidence over it is the worse failure.
  it('skips an unparseable trailing line instead of losing every wave before it', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    const s = new CampaignState(dir); s.load()
    s.appendWave({ wave: 1, decision: 'next' }); s.appendWave({ wave: 2, decision: 'next' })
    writeFileSync(join(dir, 'waves.jsonl'), readFileSync(join(dir, 'waves.jsonl'), 'utf8') + '{"wave":3,"dec')
    expect(s.waves().map(w => w.wave)).toEqual([1, 2])
  })
  it('does not carry a dead branch field on a fresh state', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    expect('branch' in new CampaignState(dir).load().state).toBe(false)
  })
  it('appends wave records as JSONL', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    const s = new CampaignState(dir); s.load()
    s.appendWave({ wave: 1, decision: 'next' }); s.appendWave({ wave: 2, decision: 'pass' })
    expect(s.waves().map(w => w.wave)).toEqual([1, 2])
    expect(readFileSync(join(dir, 'waves.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  // I2: the wave record is appended before the verdict is committed, so the
  // two fields that only exist after the commit are patched onto the last line.
  describe('rewriteLastWave', () => {
    it('replaces the last line and leaves every earlier wave untouched', () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
      const s = new CampaignState(dir); s.load()
      s.appendWave({ wave: 1, decision: 'next', verdictSha: 'a1' })
      s.appendWave({ wave: 2, decision: 'next', verdictSha: null, notified: false })
      s.rewriteLastWave({ wave: 2, decision: 'next', verdictSha: 'b2', notified: true })
      expect(s.waves()).toEqual([
        { wave: 1, decision: 'next', verdictSha: 'a1' },
        { wave: 2, decision: 'next', verdictSha: 'b2', notified: true },
      ])
      expect(readFileSync(join(dir, 'waves.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
      expect(existsSync(join(dir, 'waves.jsonl.tmp'))).toBe(false)
    })
    it('appends when there is no last line to rewrite — the record is never lost', () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
      const s = new CampaignState(dir); s.load()
      s.rewriteLastWave({ wave: 1, decision: 'fault' })
      expect(s.waves()).toEqual([{ wave: 1, decision: 'fault' }])
    })
  })

  // M9: a corrupt state.json here means an operator's --approve-proposal is
  // dropped on the floor. The merge still has to be skipped, but not silently.
  describe('adoptExternalDecisions on a corrupt state.json', () => {
    afterEach(() => { vi.restoreAllMocks() })
    it('names the reason the external decisions were not merged', () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
      const s = new CampaignState(dir); s.load(); s.save()
      writeFileSync(join(dir, 'state.json'), '{truncated')
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      s.state.proposals = [{ name: 'invariants/editGapCap', proposedAt: 't', status: 'pending' }]
      s.adoptExternalDecisions()
      expect(s.state.proposals[0].status).toBe('pending')
      expect(err).toHaveBeenCalledTimes(1)
      expect(err.mock.calls[0][0]).toMatch(/state\.json on disk is unreadable during save — external decisions not merged:/)
    })
  })
})
