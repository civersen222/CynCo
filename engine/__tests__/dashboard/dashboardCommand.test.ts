import { describe, expect, it } from 'bun:test'
import { DashboardServer } from '../../dashboard/server.js'

const PORT = 19191
describe('dashboard chat command path', () => {
  it('forwards a parsed WS command to deps.onCommand', async () => {
    const received: any[] = []
    const server = new DashboardServer({ port: PORT, deps: { onCommand: (c) => received.push(c) } })
    await new Promise(r => setTimeout(r, 100))
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('x')) })
    ws.send(JSON.stringify({ type: 'vibe.start', mode: 'new', description: 'hi' }))
    await new Promise(r => setTimeout(r, 150))
    ws.close(); server.stop()
    expect(received.some(c => c.type === 'vibe.start')).toBe(true)
  })
})
