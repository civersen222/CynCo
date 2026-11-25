import { describe, expect, it, afterAll } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// NOW.md (containment backlog): the per-iteration debug file `.cynco-debug.json` beside the stream
// log was written with a plain writeFileSync, which follows whatever the name is. The folder is the
// mission folder, which a contained run writes, so a run that leaves a hard link of that name to a
// file of the owner's had the engine (at medium integrity) overwrite that file on every model call.
// The file is now written only when it is a regular file with one name, as `appendCapped` judges
// the stream log beside it.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-debugfile-'))
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true,
  }
}

function capabilities(): ModelCapabilities {
  return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function provider(): Provider {
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { return capabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> { yield* textResponse('done') },
  }
}

async function oneTurn(cwd: string): Promise<void> {
  const loop = new ConversationLoop({ cwd, config: config(), provider: provider(), emit: () => {} })
  await loop.handleUserMessage('hi')
}

function folder(name: string): string {
  const d = path.join(ROOT, name)
  fs.mkdirSync(d)
  return d
}

describe('.cynco-debug.json is written only as a file of its own', () => {
  it('is written when it does not exist yet, as JSON', async () => {
    const cwd = folder('fresh')
    await oneTurn(cwd)
    const body = JSON.parse(fs.readFileSync(path.join(cwd, '.cynco-debug.json'), 'utf-8'))
    expect(typeof body.iteration).toBe('number')
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('replaces a longer earlier file whole: no tail of the old text is left after the JSON', async () => {
    const cwd = folder('longer')
    const p = path.join(cwd, '.cynco-debug.json')
    fs.writeFileSync(p, 'x'.repeat(200_000))
    await oneTurn(cwd)
    const text = fs.readFileSync(p, 'utf-8')
    expect(text).not.toContain('xxxx')
    expect(typeof JSON.parse(text).iteration).toBe('number')
  })

  // Wave 15b, check C4-7: when the name was free at the look, the open created whatever was there by
  // then (O_CREAT without O_EXCL), so a name made in between (a symbolic link to a file of the
  // owner's, on a PC that lets the run make one) was opened and truncated: fstat shows a regular file
  // with one name, and with nothing seen at the look there was nothing to compare. A file that appears
  // between the look and the open stands in for that link here (making a symbolic link needs a
  // privilege this suite does not have); the name it appears under is never written.
  it('does not write a file that appeared under the name between the look and the open', async () => {
    const cwd = folder('race')
    const p = path.join(cwd, '.cynco-debug.json')
    const realFs = createRequire(import.meta.url)('fs') as typeof import('fs')
    const lstat = realFs.lstatSync
    let raced = 0
    realFs.lstatSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      try {
        return (lstat as (...a: unknown[]) => fs.Stats)(target, ...rest)
      } catch (e) {
        if (String(target) === p && (e as NodeJS.ErrnoException).code === 'ENOENT' && raced === 0) {
          raced++
          fs.writeFileSync(p, 'the owner\'s notes\n')
        }
        throw e
      }
    }) as typeof realFs.lstatSync
    try {
      await oneTurn(cwd)
    } finally {
      realFs.lstatSync = lstat
    }
    expect(raced).toBe(1)
    expect(fs.readFileSync(p, 'utf-8')).toBe('the owner\'s notes\n')
  })

  it('does not write through a hard link to a file elsewhere', async () => {
    const cwd = folder('hardlink')
    const victimDir = folder('owners')
    const victim = path.join(victimDir, 'notes.txt')
    fs.writeFileSync(victim, 'the owner\'s notes\n')
    fs.linkSync(victim, path.join(cwd, '.cynco-debug.json'))
    await oneTurn(cwd)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('the owner\'s notes\n')
  })
})
