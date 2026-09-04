/**
 * A llama-server restart (crash, adapter swap) used to cost the whole
 * conversation's prefill: 45k tokens re-prefilled from nothing. Quartermaster
 * snapshots the slot's KV to disk before eviction and restores it after.
 * llama-server has the primitives (--slot-save-path, POST /slots/0?action=
 * save|restore); this wires them to the moments we control.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildServerArgs, ProcessManager, SLOT_SNAPSHOT_FILE } from '../../llama/processManager.js'

function argValue(args: string[], flag: string): string | undefined { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }

describe('slot snapshot flags', () => {
  it('emits --slot-save-path when a directory is configured, and nothing otherwise', () => {
    expect(argValue(buildServerArgs({ modelPath: 'm', port: 1, slotSavePath: 'C:/x/slots' }), '--slot-save-path')).toBe('C:/x/slots')
    expect(buildServerArgs({ modelPath: 'm', port: 1 })).not.toContain('--slot-save-path')
  })
})

describe('saveSlot / restoreSlot', () => {
  function pmWithFetch(calls: Array<{ url: string; body: any }>, response: any = { n_saved: 100 }) {
    const dir = mkdtempSync(join(tmpdir(), 'slots-'))
    const pm = new ProcessManager({ binaryPath: 'x', modelPath: 'm', port: 8081, slotSavePath: dir,
      fetchImpl: (async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') }); return new Response(JSON.stringify(response), { status: 200 }) }) as any })
    return { pm, dir }
  }

  it('saveSlot POSTs /slots/0?action=save with the snapshot filename', async () => {
    const calls: any[] = []; const { pm, dir } = pmWithFetch(calls)
    try {
      const r = await pm.saveSlot()
      expect(r.ok).toBe(true)
      expect(calls[0].url).toBe('http://127.0.0.1:8081/slots/0?action=save')
      expect(calls[0].body).toEqual({ filename: SLOT_SNAPSHOT_FILE })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('restoreSlot only asks the server when the snapshot file exists', async () => {
    const calls: any[] = []; const { pm, dir } = pmWithFetch(calls, { n_restored: 100 })
    try {
      expect((await pm.restoreSlot()).ok).toBe(false)         // no file yet
      expect(calls).toHaveLength(0)
      writeFileSync(join(dir, SLOT_SNAPSHOT_FILE), 'x')
      expect((await pm.restoreSlot()).ok).toBe(true)
      expect(calls[0].url).toBe('http://127.0.0.1:8081/slots/0?action=restore')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('noteTurnComplete saves at most once per interval', async () => {
    const calls: any[] = []; const { pm, dir } = pmWithFetch(calls)
    try {
      let now = 1_000_000
      ;(pm as any).now = () => now
      pm.noteTurnComplete(); await new Promise(r => setTimeout(r, 20))
      expect(calls).toHaveLength(1)                            // first turn saves (lastSave = 0)
      pm.noteTurnComplete(); await new Promise(r => setTimeout(r, 20))
      expect(calls).toHaveLength(1)                            // inside the interval: no save
      now += 301_000
      pm.noteTurnComplete(); await new Promise(r => setTimeout(r, 20))
      expect(calls).toHaveLength(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a server error is reported, not thrown, and does not count as a save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slots-'))
    const pm = new ProcessManager({ binaryPath: 'x', modelPath: 'm', port: 8081, slotSavePath: dir,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'slot save path not set' } }), { status: 400 })) as any })
    try {
      const r = await pm.saveSlot()
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/HTTP 400/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
