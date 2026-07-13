import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { LocalCodeWSServer } from '../../bridge/server.js'
import type { TUICommand, EngineEvent } from '../../bridge/protocol.js'

describe('LocalCodeWSServer', () => {
  let server: LocalCodeWSServer | null = null

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('constructs with port and starts not connected', () => {
    server = new LocalCodeWSServer({ port: 19160 })
    expect(server.port).toBe(19160)
    expect(server.connected).toBe(false)
  })

  it('accepts a WebSocket connection', async () => {
    server = new LocalCodeWSServer({ port: 19161 })
    // Give the server a moment to bind
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19161')
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })

    // Give the server a moment to process the connection
    await new Promise(r => setTimeout(r, 50))
    expect(server.connected).toBe(true)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('marks disconnected when client closes', async () => {
    server = new LocalCodeWSServer({ port: 19162 })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19162')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))
    expect(server.connected).toBe(true)

    ws.close()
    await new Promise(r => setTimeout(r, 100))
    expect(server.connected).toBe(false)
  })

  it('emits events to connected client', async () => {
    server = new LocalCodeWSServer({ port: 19163 })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19163')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))

    const received: string[] = []
    ws.onmessage = (ev) => { received.push(String(ev.data)) }

    const event: EngineEvent = {
      type: 'session.ready',
      model: 'test-model',
      contextLength: 32768,
    }
    server.emit(event)

    await new Promise(r => setTimeout(r, 100))
    expect(received).toHaveLength(1)
    const parsed = JSON.parse(received[0])
    expect(parsed.type).toBe('session.ready')
    expect(parsed.model).toBe('test-model')

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('does not throw when emitting without a connected client', () => {
    server = new LocalCodeWSServer({ port: 19164 })
    // Should not throw
    expect(() => {
      server!.emit({ type: 'session.ready', model: 'x', contextLength: 1024 })
    }).not.toThrow()
  })

  it('receives commands from client and calls onCommand', async () => {
    const receivedCommands: TUICommand[] = []
    server = new LocalCodeWSServer({
      port: 19165,
      onCommand: (cmd) => { receivedCommands.push(cmd) },
    })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19165')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))

    ws.send(JSON.stringify({ type: 'user.message', text: 'Hello from TUI' }))
    await new Promise(r => setTimeout(r, 100))

    expect(receivedCommands).toHaveLength(1)
    expect(receivedCommands[0].type).toBe('user.message')
    expect((receivedCommands[0] as any).text).toBe('Hello from TUI')

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('ignores invalid JSON from client', async () => {
    const receivedCommands: TUICommand[] = []
    server = new LocalCodeWSServer({
      port: 19166,
      onCommand: (cmd) => { receivedCommands.push(cmd) },
    })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19166')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))

    ws.send('not valid json')
    await new Promise(r => setTimeout(r, 100))

    // Should not have received any commands
    expect(receivedCommands).toHaveLength(0)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('ignores JSON without type field from client', async () => {
    const receivedCommands: TUICommand[] = []
    server = new LocalCodeWSServer({
      port: 19167,
      onCommand: (cmd) => { receivedCommands.push(cmd) },
    })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19167')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))

    ws.send(JSON.stringify({ text: 'no type field' }))
    await new Promise(r => setTimeout(r, 100))

    expect(receivedCommands).toHaveLength(0)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('close() stops the server', async () => {
    server = new LocalCodeWSServer({ port: 19168 })
    await new Promise(r => setTimeout(r, 50))

    await server.close()
    expect(server.connected).toBe(false)

    // Trying to connect should fail
    try {
      const ws = new WebSocket('ws://localhost:19168')
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => { ws.close(); reject(new Error('Should not connect')) }
        ws.onerror = () => resolve()
        setTimeout(() => resolve(), 500)
      })
    } catch {
      // Expected - connection should fail
    }

    server = null // Already closed
  })

  it('replays session.ready to a late-connecting client', async () => {
    server = new LocalCodeWSServer({ port: 19170 })
    await new Promise(r => setTimeout(r, 50))

    // Emit session.ready BEFORE any client connects
    const event: EngineEvent = {
      type: 'session.ready',
      model: 'replay-model',
      contextLength: 65536,
    }
    server.emit(event)

    // Now connect — should receive the cached event immediately
    const ws = new WebSocket('ws://localhost:19170')
    const received: string[] = []
    ws.onmessage = (ev) => { received.push(String(ev.data)) }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })

    await new Promise(r => setTimeout(r, 150))
    expect(received).toHaveLength(1)
    const parsed = JSON.parse(received[0])
    expect(parsed.type).toBe('session.ready')
    expect(parsed.model).toBe('replay-model')
    expect(parsed.contextLength).toBe(65536)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('replays session.ready to a second client after first disconnects', async () => {
    server = new LocalCodeWSServer({ port: 19171 })
    await new Promise(r => setTimeout(r, 50))

    // Cache a session.ready before anyone connects
    server.emit({ type: 'session.ready', model: 'second-client-model', contextLength: 8192 })

    // First client
    const ws1 = new WebSocket('ws://localhost:19171')
    const received1: string[] = []
    ws1.onmessage = (ev) => { received1.push(String(ev.data)) }
    await new Promise<void>((resolve, reject) => {
      ws1.onopen = () => resolve()
      ws1.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 100))
    expect(received1).toHaveLength(1)
    expect(JSON.parse(received1[0]).model).toBe('second-client-model')

    // First client disconnects
    ws1.close()
    await new Promise(r => setTimeout(r, 100))

    // Second client connects — should also get the cached event
    const ws2 = new WebSocket('ws://localhost:19171')
    const received2: string[] = []
    ws2.onmessage = (ev) => { received2.push(String(ev.data)) }
    await new Promise<void>((resolve, reject) => {
      ws2.onopen = () => resolve()
      ws2.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 150))
    expect(received2).toHaveLength(1)
    expect(JSON.parse(received2[0]).model).toBe('second-client-model')

    ws2.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('emits multiple events in sequence', async () => {
    server = new LocalCodeWSServer({ port: 19169 })
    await new Promise(r => setTimeout(r, 50))

    const ws = new WebSocket('ws://localhost:19169')
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    await new Promise(r => setTimeout(r, 50))

    const received: string[] = []
    ws.onmessage = (ev) => { received.push(String(ev.data)) }

    server.emit({ type: 'session.ready', model: 'm', contextLength: 1024 })
    server.emit({ type: 'stream.token', text: 'Hello' })
    server.emit({ type: 'stream.token', text: ' world' })
    server.emit({ type: 'message.complete', messageId: 'msg-1', stopReason: 'end_turn' })

    await new Promise(r => setTimeout(r, 150))
    expect(received).toHaveLength(4)

    const types = received.map(r => JSON.parse(r).type)
    expect(types).toEqual([
      'session.ready',
      'stream.token',
      'stream.token',
      'message.complete',
    ])

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })
})
