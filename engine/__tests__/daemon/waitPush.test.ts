/**
 * Tell the phone when the engine waits (docs/NOW.md, Next: "Tell the phone
 * when the engine waits").
 *
 * An approval card auto-denies after five minutes and an AskUser question
 * resolves empty after five minutes. A phone whose screen locked has no socket,
 * so the frame that drew the card went to nobody and the turn went on without
 * its owner. `WaitPush` sends one ntfy notification when a wait is still open
 * after a short grace and no client is connected.
 *
 * What these pin, each against a production change that would break it:
 *  - the push asks what is PENDING, not what was emitted: the frame precedes
 *    the registration, and the beginner/risky warning frame never waits;
 *  - a connected client (dashboard socket or TUI) means no push;
 *  - a failed or throwing publish is logged and goes no further.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { WaitPush, waitNotice, WAIT_PUSH_GRACE_MS, type WaitingOn } from '../../daemon/waitPush.js'
import { ntfyOptionsFromEnv } from '../../daemon/ntfyChannel.js'

const tick = (ms = 15) => new Promise(r => setTimeout(r, ms))

function rig(opts: { pending?: WaitingOn[]; clients?: number; publish?: (p: any) => Promise<boolean> } = {}) {
  const sent: any[] = []
  const logs: string[] = []
  const state = { pending: opts.pending ?? [], clients: opts.clients ?? 0 }
  const push = new WaitPush({
    publish: opts.publish ?? (async (p) => { sent.push(p); return true }),
    pending: () => state.pending,
    clientCount: () => state.clients,
    graceMs: 0,
    log: (l: string) => logs.push(l),
  })
  return { push, sent, logs, state }
}

const approval: WaitingOn = { kind: 'approval', requestId: 'r1', toolName: 'Bash', description: 'Run: git push origin main' }
const ask: WaitingOn = { kind: 'ask', requestId: 'q1', question: 'Which branch should I use?', options: ['main', 'dev'] }

describe('WaitPush', () => {
  it('pushes once when an approval is still waiting after the grace and no client is connected', async () => {
    const { push, sent } = rig({ pending: [approval] })
    push.onEvent({ type: 'approval.request', requestId: 'r1' })
    expect(sent).toEqual([])
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('CynCo needs your approval')
    expect(sent[0].message).toContain('Bash: Run: git push origin main')
    expect(sent[0].priority).toBe(4)
  })

  it('pushes a waiting question with its options', async () => {
    const { push, sent } = rig({ pending: [ask] })
    push.onEvent({ type: 'ask.request', requestId: 'q1' })
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('CynCo has a question')
    expect(sent[0].message).toContain('Which branch should I use?')
    expect(sent[0].message).toContain('main / dev')
  })

  it('sends nothing while a client is connected', async () => {
    const { push, sent } = rig({ pending: [approval], clients: 1 })
    push.onEvent({ type: 'approval.request', requestId: 'r1' })
    await tick()
    expect(sent).toEqual([])
  })

  it('sends nothing when a client connects during the grace', async () => {
    const { push, sent, state } = rig({ pending: [approval] })
    push.onEvent({ type: 'approval.request', requestId: 'r1' })
    state.clients = 1
    await tick()
    expect(sent).toEqual([])
  })

  it('sends nothing for a frame the engine is not waiting on (answered, or the warning frame that never waits)', async () => {
    const { push, sent } = rig({ pending: [] })
    push.onEvent({ type: 'approval.request', requestId: 'tool-7' })
    await tick()
    expect(sent).toEqual([])
  })

  it('ignores every other event', async () => {
    const { push, sent } = rig({ pending: [approval] })
    push.onEvent({ type: 'tool.start', requestId: 'r1' })
    push.onEvent({ type: 'approval.request' })
    await tick()
    expect(sent).toEqual([])
  })

  it('a publish that fails is logged, with no part of the request in the log', async () => {
    const { push, logs } = rig({ pending: [approval], publish: async () => false })
    push.onEvent({ type: 'approval.request', requestId: 'r1' })
    await tick()
    expect(logs.join(' ')).toContain('not delivered')
    expect(logs.join(' ')).not.toContain('git push')
  })

  it('a publish that throws is logged and does not escape', async () => {
    const { push, logs } = rig({ pending: [approval], publish: async () => { throw new Error('boom') } })
    push.onEvent({ type: 'approval.request', requestId: 'r1' })
    await tick()
    expect(logs.join(' ')).toContain('boom')
  })

  it('waits five seconds by default', () => {
    expect(WAIT_PUSH_GRACE_MS).toBe(5000)
  })
})

describe('waitNotice', () => {
  it('caps a long description so a notification stays a notification', () => {
    const n = waitNotice({ kind: 'approval', requestId: 'r', toolName: 'Bash', description: 'x'.repeat(2000) })
    expect(n.message.length).toBeLessThanOrEqual(400)
    expect(n.message).toContain('…')
  })

  it('says what happens when nobody answers', () => {
    expect(waitNotice(approval).message).toContain('Refused if nobody answers within 5 minutes')
    expect(waitNotice(ask).message).toContain('Goes on without an answer after 5 minutes')
  })
})

describe('ntfyOptionsFromEnv', () => {
  it('is null without CYNCO_NTFY_URL: the push is off unless the engine is told where ntfy is', () => {
    expect(ntfyOptionsFromEnv({})).toBeNull()
    expect(ntfyOptionsFromEnv({ CYNCO_NTFY_URL: '' })).toBeNull()
  })

  it('reads the same variables and defaults the daemon uses', () => {
    expect(ntfyOptionsFromEnv({ CYNCO_NTFY_URL: 'http://10.0.0.1:8090' })).toEqual({
      baseUrl: 'http://10.0.0.1:8090', token: undefined, alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands',
    })
    expect(ntfyOptionsFromEnv({ CYNCO_NTFY_URL: 'http://h', CYNCO_NTFY_TOKEN: 't', CYNCO_NTFY_ALERT_TOPIC: 'a', CYNCO_NTFY_COMMAND_TOPIC: 'c' })).toEqual({
      baseUrl: 'http://h', token: 't', alertTopic: 'a', commandTopic: 'c',
    })
  })
})

describe('the five minutes a notice names', () => {
  // The notice tells the owner how long they have. If either timeout changes, this is where it is noticed.
  const engine = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const read = (rel: string) => readFileSync(join(engine, rel), 'utf-8')

  it('are the approval auto-deny in the conversation loop', () => {
    const src = read('bridge/conversationLoop.ts')
    const at = src.indexOf('const requestApproval: RequestApprovalFn = async')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 700)).toContain('}, 300000)')
  })

  it('are the question timeout in AskBroker', () => {
    expect(read('tools/askBroker.ts')).toContain('opts?.timeoutMs ?? 300000')
  })
})
