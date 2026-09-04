import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseCheckpointLine, fitAffine, CheckpointCalibrator } from '../../llama/checkpointCalibration.js'
import { MEASURED_DEFAULT_COST } from '../../llama/checkpointCost.js'

describe('parseCheckpointLine', () => {
  it('reads n_tokens and size from a real llama-server line', () => {
    const line = '0.16.704.755 I slot create_check: id  0 | task 0 | created context checkpoint 1 of 32 (pos_min = 10101, pos_max = 10101, n_tokens = 10102, size = 189.280 MiB)'
    expect(parseCheckpointLine(line)).toEqual({ tokens: 10102, mib: 189.28 })
  })
  it('ignores restores and unrelated lines', () => {
    expect(parseCheckpointLine('W slot update_slots: id 0 | task 55 | restored context checkpoint (pos_min = 11788, n_tokens = 11789, size = 195.902 MiB)')).toBeNull()
    expect(parseCheckpointLine('prompt eval time = 1 ms')).toBeNull()
  })
})

describe('fitAffine', () => {
  it('recovers the intercept and slope from the three F91 measurements', () => {
    const fit = fitAffine([{ tokens: 22, mib: 149.713 }, { tokens: 91867, mib: 510.234 }, { tokens: 93911, mib: 518.257 }])
    expect(fit).not.toBeNull()
    expect(fit!.baseMib).toBeCloseTo(149.6, 0)
    expect(fit!.kibPerToken).toBeCloseTo(4.02, 1)
  })
  it('refuses to fit from a single point or a zero token spread', () => {
    expect(fitAffine([{ tokens: 100, mib: 150 }])).toBeNull()
    expect(fitAffine([{ tokens: 100, mib: 150 }, { tokens: 100, mib: 151 }])).toBeNull()
  })
})

describe('CheckpointCalibrator', () => {
  it('stays quiet until the observations span enough tokens, then persists a fit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckptcal-'))
    try {
      const warnings: string[] = []
      const cal = new CheckpointCalibrator({ model: MEASURED_DEFAULT_COST, modelKey: 'm.gguf', storeDir: dir, warn: w => warnings.push(w), minTokenSpread: 2000 })
      cal.observe('created context checkpoint 1 of 32 (pos_min = 22, pos_max = 22, n_tokens = 22, size = 149.713 MiB)')
      expect(cal.fit).toBeNull()
      cal.observe('created context checkpoint 2 of 32 (pos_min = 91867, pos_max = 91867, n_tokens = 91867, size = 510.234 MiB)')
      expect(cal.fit).not.toBeNull()
      expect(cal.fit!.kibPerToken).toBeCloseTo(4.02, 1)
      expect(existsSync(join(dir, 'checkpoint-calibration.json'))).toBe(true)
      const stored = JSON.parse(readFileSync(join(dir, 'checkpoint-calibration.json'), 'utf-8'))
      expect(stored['m.gguf'].kibPerToken).toBeCloseTo(4.02, 1)
      // Model and measurement agree within tolerance — no warning.
      expect(warnings).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('warns once when the live server disagrees with the model by more than 15%', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckptcal-'))
    try {
      const warnings: string[] = []
      const wrong = { ...MEASURED_DEFAULT_COST, kibPerToken: 19.7, detail: 'the F91 proportional misread' }
      const cal = new CheckpointCalibrator({ model: wrong, modelKey: 'm.gguf', storeDir: dir, warn: w => warnings.push(w), minTokenSpread: 2000 })
      cal.observe('created context checkpoint 1 of 32 (n_tokens = 22, size = 149.713 MiB)')
      cal.observe('created context checkpoint 2 of 32 (n_tokens = 91867, size = 510.234 MiB)')
      cal.observe('created context checkpoint 3 of 32 (n_tokens = 93911, size = 518.257 MiB)')
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toMatch(/predicted .* measured/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a stored calibration for the same model key is loaded as the preferred cost model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckptcal-'))
    try {
      const cal = new CheckpointCalibrator({ model: MEASURED_DEFAULT_COST, modelKey: 'm.gguf', storeDir: dir, warn: () => {}, minTokenSpread: 2000 })
      cal.observe('created context checkpoint 1 of 32 (n_tokens = 22, size = 149.713 MiB)')
      cal.observe('created context checkpoint 2 of 32 (n_tokens = 91867, size = 510.234 MiB)')
      const loaded = CheckpointCalibrator.loadStored(dir, 'm.gguf')
      expect(loaded).not.toBeNull()
      expect(loaded!.source).toBe('calibrated')
      expect(CheckpointCalibrator.loadStored(dir, 'other.gguf')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
