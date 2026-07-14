import { describe, it, expect } from 'vitest'
import { FingerprintRepetitionDetector } from '../../vsm/fingerprintRepetition.js'

describe('FingerprintRepetitionDetector (P4.3)', () => {
  it('no alarm on empty or short history', () => {
    const d = new FingerprintRepetitionDetector()
    expect(d.alarm()).toBeNull()
    d.recordCall('Read', { file_path: 'a.ts' })
    expect(d.alarm()).toBeNull()
  })

  it('alarms identical on 3 consecutive identical fingerprints', () => {
    const d = new FingerprintRepetitionDetector()
    for (let i = 0; i < 3; i++) d.recordCall('Read', { file_path: 'a.ts' })
    expect(d.alarm()).toBe('identical')
  })

  it('does not alarm on 2 identical', () => {
    const d = new FingerprintRepetitionDetector()
    d.recordCall('Read', { file_path: 'a.ts' })
    d.recordCall('Read', { file_path: 'a.ts' })
    expect(d.alarm()).toBeNull()
  })

  it('different args are distinct fingerprints — no alarm', () => {
    const d = new FingerprintRepetitionDetector()
    d.recordCall('Read', { file_path: 'a.ts' })
    d.recordCall('Read', { file_path: 'b.ts' })
    d.recordCall('Read', { file_path: 'c.ts' })
    expect(d.alarm()).toBeNull()
  })

  it('whitelisted tool never alarms', () => {
    const d = new FingerprintRepetitionDetector()
    for (let i = 0; i < 5; i++) d.recordCall('ContractStatus', {})
    expect(d.alarm()).toBeNull()
  })

  it('alarms alternating on A-B-A-B-A-B', () => {
    const d = new FingerprintRepetitionDetector()
    for (let i = 0; i < 3; i++) {
      d.recordCall('Read', { file_path: 'a.ts' })
      d.recordCall('Grep', { pattern: 'x' })
    }
    expect(d.alarm()).toBe('alternating')
  })

  it('does not alarm alternating on only A-B-A-B', () => {
    const d = new FingerprintRepetitionDetector()
    for (let i = 0; i < 2; i++) {
      d.recordCall('Read', { file_path: 'a.ts' })
      d.recordCall('Grep', { pattern: 'x' })
    }
    expect(d.alarm()).toBeNull()
  })

  it('interruption breaks a consecutive-identical run', () => {
    const d = new FingerprintRepetitionDetector()
    d.recordCall('Read', { file_path: 'a.ts' })
    d.recordCall('Read', { file_path: 'a.ts' })
    d.recordCall('Write', { file_path: 'b.ts' })
    d.recordCall('Read', { file_path: 'a.ts' })
    expect(d.alarm()).toBeNull()
  })
})
