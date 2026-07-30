// Files changed through the shell must be visible as files the agent modified.
//
// Measured on the live L3-3.3 run: CynCo added 193 lines to
// gilded/tests/test_docket.py using `Add-Content` and
// `python -c "open(...,'w')"` through Bash. The recorded trajectory reported
// `filesTouched: 0`.
//
// Root cause: FileOperationTracker.getModifiedFiles() filters on a whitelist of
// four tool NAMES. It is named and consumed as "files the agent modified" but it
// only ever measured "invocations of Write/Edit/MultiEdit/ApplyPatch". A
// mutation through the shell was absent, and the consumer read 0 — a plausible
// default standing in for "nobody looked at the filesystem".
//
// Two consumers were wrong as a result:
//   1. filesTouched (conversationLoop.ts) — a state feature in every training
//      row, reading 0 while files demonstrably changed.
//   2. diffClean (training/taskOutcome.ts) — wasTracked() consults the same
//      tracker, so a path the agent honestly dirtied from the shell failed the
//      filter and the agent was charged for its own work.
//
// The fix measures with git rather than guessing from the command text. Parsing
// shell strings for filenames would be a substring proxy for the thing actually
// wanted, which is the mistake that produced a confident false negative in the
// L2f harness.
import { describe, it, expect, afterAll } from 'vitest'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { FileOperationTracker } from '../../context/compressor.js'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const compressorSrc = readFileSync('engine/context/compressor.ts', 'utf-8')

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-shellwrite-'))
afterAll(() => {
  fs.rmSync(REPO, { recursive: true, force: true, maxRetries: 5 })
})

function git(args: string, cwd = REPO) {
  return execSync(`git ${args}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString()
}

// A real repo with one committed, tracked file — so an append to it shows up as
// a content change rather than as a new untracked path. That distinction is the
// whole point: a set-difference over `git status` paths would miss it, because
// re-modifying an already-modified file leaves the porcelain line identical.
git('init -q')
git('config user.email test@example.com')
git('config user.name Test')
fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'original\n')
git('add tracked.txt')
git('commit -q -m initial')

describe('FileOperationTracker counts shell-measured writes', () => {
  it('a ShellWrite record is a modification, not a read', () => {
    const t = new FileOperationTracker()
    t.record('a/b.py', 'ShellWrite')
    expect(t.getModifiedFiles()).toEqual(['a/b.py'])
    expect(t.getReadFiles()).toEqual([])
  })

  it('the modification whitelist is not limited to the four editing tools', () => {
    // Guard, not a gate: it passes as soon as the feature works at all. It is
    // here so that a later tidy-up of the whitelist cannot silently restore the
    // blindness this file exists to remove.
    expect(compressorSrc).toMatch(/'ShellWrite'/)
  })
})

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
  } as LocalCodeConfig
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function mockProvider(gens: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = gens[callIdx++]
      if (gen) yield* gen()
    },
  }
}

function bashTurn(command: string) {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_stop' } as any
  }
}

function* silence(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm2', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any
}

async function runBash(command: string) {
  const loopInstance = new ConversationLoop({
    cwd: REPO,
    config: { ...defaultConfig(), approveAll: true } as LocalCodeConfig,
    provider: mockProvider([bashTurn(command), silence]),
    emit: () => {},
    allowedTools: ['Bash'],
  })
  await loopInstance.handleUserMessage('do the thing')
  return loopInstance.getFileTracker().getModifiedFiles().map(p => p.replace(/\\/g, '/'))
}

describe('shell writes reach the file tracker (behavioral)', () => {
  it('appending to an already-tracked file is recorded as a modification', async () => {
    // node, not Add-Content or a redirect: the executor's shell differs by
    // platform, and node is the one interpreter guaranteed present here.
    const modified = await runBash(
      `node -e "require('fs').appendFileSync('tracked.txt','appended\\n')"`,
    )
    expect(fs.readFileSync(path.join(REPO, 'tracked.txt'), 'utf-8')).toContain('appended')
    expect(modified.some(p => p.endsWith('tracked.txt'))).toBe(true)
  })

  it('creating a brand-new file from the shell is recorded as a modification', async () => {
    const modified = await runBash(
      `node -e "require('fs').writeFileSync('created.txt','new\\n')"`,
    )
    expect(modified.some(p => p.endsWith('created.txt'))).toBe(true)
  })

  it('a read-only shell command records no modification', async () => {
    // Guard, not a gate — it passes at HEAD, where nothing is ever recorded.
    // It exists so the fix cannot become a rubber stamp: if every Bash call were
    // attributed a write, filesTouched would be as uninformative as it was
    // before, merely wrong in the other direction. Note the repo is already
    // dirty from the two tests above, so this also pins that the attribution is
    // a per-call delta and not a snapshot of the whole tree.
    const modified = await runBash(`node -e "require('fs').readFileSync('tracked.txt')"`)
    expect(modified).toEqual([])
  })
})
