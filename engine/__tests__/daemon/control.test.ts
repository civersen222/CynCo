// engine/__tests__/daemon/control.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultControlPath, readControl } from '../../daemon/control.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-ctl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('readControl', () => {
  it('a missing file means not paused', () => {
    expect(readControl(join(dir, 'daemon-control.json'))).toEqual({ paused: false })
  })

  it('reads a pause request with its timestamp', () => {
    const p = join(dir, 'daemon-control.json')
    writeFileSync(p, JSON.stringify({ paused: true, requestedAt: '2026-11-06T21:00:00Z' }), 'utf-8')
    expect(readControl(p)).toEqual({ paused: true, requestedAt: '2026-11-06T21:00:00Z' })
  })

  it('paused: false and a torn file both mean not paused', () => {
    const p = join(dir, 'daemon-control.json')
    writeFileSync(p, JSON.stringify({ paused: false }), 'utf-8')
    expect(readControl(p).paused).toBe(false)
    writeFileSync(p, '{"paused": tr', 'utf-8')
    expect(readControl(p).paused).toBe(false)
    writeFileSync(p, JSON.stringify({ paused: 'yes' }), 'utf-8')
    expect(readControl(p).paused).toBe(false)
  })

  it('lives in the cynco home next to missions/', () => {
    expect(defaultControlPath('C:/Users/x/.cynco').replace(/\\/g, '/')).toBe('C:/Users/x/.cynco/daemon-control.json')
  })
})
