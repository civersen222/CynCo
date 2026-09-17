import { describe, it, expect } from 'vitest'
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
  it('appends wave records as JSONL', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
    const s = new CampaignState(dir); s.load()
    s.appendWave({ wave: 1, decision: 'next' }); s.appendWave({ wave: 2, decision: 'pass' })
    expect(s.waves().map(w => w.wave)).toEqual([1, 2])
    expect(readFileSync(join(dir, 'waves.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
