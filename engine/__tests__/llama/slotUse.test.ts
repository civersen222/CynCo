/**
 * What the model server has been doing, as it says itself (`ProcessManager.slotUse`).
 *
 * The idle unloader asks this before it unloads (`IdleUnloader`, `serverUse`): an app CynCo took
 * the GPU from is answered by CynCo's server, and its requests are no activity of CynCo's. The
 * shape is `GET /slots` as llama-server build b9529 answers it: one object per slot with `id`,
 * `id_task` (the last task that slot ran) and `is_processing`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ProcessManager } from '../../llama/processManager.js'

function pm(respond: (url: string) => Response | Promise<Response>, seen: string[] = []) {
  return new ProcessManager({
    binaryPath: 'x', modelPath: 'm', port: 8081,
    fetchImpl: (async (url: any) => { seen.push(String(url)); return respond(String(url)) }) as any,
  })
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const slot = (id: number, idTask: number, processing = false) => ({ id, id_task: idTask, n_ctx: 131072, speculative: false, is_processing: processing })

describe('ProcessManager.slotUse', () => {
  it('asks the server on its own port for its slots', async () => {
    const seen: string[] = []
    await pm(() => json([slot(0, 41)]), seen).slotUse()
    expect(seen).toEqual(['http://127.0.0.1:8081/slots'])
  })

  it('an idle slot: not processing, and a token that names the last task it ran', async () => {
    expect(await pm(() => json([slot(0, 41)])).slotUse()).toEqual({ processing: false, tasks: '0:41' })
  })

  it('the token changes when a slot runs another task, and only then', async () => {
    const a = await pm(() => json([slot(0, 41)])).slotUse()
    const again = await pm(() => json([slot(0, 41)])).slotUse()
    const b = await pm(() => json([slot(0, 57)])).slotUse()
    expect(again!.tasks).toBe(a!.tasks)
    expect(b!.tasks).not.toBe(a!.tasks)
  })

  it('a slot generating now is processing; with several slots any one of them is enough', async () => {
    expect(await pm(() => json([slot(0, 41, true)])).slotUse()).toEqual({ processing: true, tasks: '0:41' })
    expect(await pm(() => json([slot(0, 41), slot(1, 44, true)])).slotUse()).toEqual({ processing: true, tasks: '0:41,1:44' })
  })

  it('a slot that has run nothing yet has a task id too', async () => {
    expect(await pm(() => json([slot(0, -1)])).slotUse()).toEqual({ processing: false, tasks: '0:-1' })
  })

  it('a server that does not answer, refuses, or answers something else is null: unread, not "idle"', async () => {
    expect(await pm(() => { throw new Error('ECONNREFUSED') }).slotUse()).toBeNull()
    expect(await pm(() => json({ error: { message: 'This server does not support slots endpoint.' } }, 501)).slotUse()).toBeNull()
    expect(await pm(() => json({ slots: [] })).slotUse()).toBeNull()
    expect(await pm(() => json([])).slotUse()).toBeNull()
    expect(await pm(() => new Response('not json', { status: 200 })).slotUse()).toBeNull()
  })

  it('a slot list without task ids (another build of the server) is null: it cannot say who was answered', async () => {
    expect(await pm(() => json([{ id: 0, is_processing: false }])).slotUse()).toBeNull()
    expect(await pm(() => json([{ id: 0, id_task: '41', is_processing: false }])).slotUse()).toBeNull()
  })
})

describe('the engine asks the server before it unloads an idle model (wiring, by text)', () => {
  it('bootstrapProvider gives the idle unloader the process manager\'s reading', () => {
    const src = readFileSync(join(process.cwd(), 'engine', 'bootstrapProvider.ts'), 'utf-8')
    const at = src.indexOf('new IdleUnloader({')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 900)).toContain('serverUse: () => processManager.slotUse()')
  })
})
