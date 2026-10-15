/**
 * F178, the two counters it left open: a batch the model fired together is one
 * decision. `ToolGating`'s four-in-a-row rule counted every call of a parallel
 * batch, so a model that read four files in one batch had Read withheld from
 * its next call ("not available this turn") — and Read is attenuable while
 * Bash never is, so a project chat with Read withheld reads through the shell,
 * the path F178 closed for the circuit breaker and the trust score. Pinned
 * here on the live loop:
 * - the gate counts a tool at most once per model call (`beginCall`, marked
 *   where the loop clears `toolFailedThisCall`);
 * - in a project chat the gate never attenuates Read (it reads files to
 *   answer; `ReadLoopGate` already governs redundant re-reads);
 * - a coding session (and so a mission) still has a tool used in four model
 *   calls in a row attenuated, Read included.
 * The trust score's half (at most one success and one failure per tool per
 * model call) is pinned in `engine/__tests__/toolScorer.test.ts`, and on the
 * live loop below, where the loop marks each call on the executor
 * (`beginModelCall`). The algedonic kill switch (five consecutive pains halt a
 * session): a repeat failure of a tool in the same call is neutral — it neither
 * adds pain nor clears it — until any counted success clears the streak; after
 * that the tool's next failure is a pain again.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, projectDir } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { makeLoop, type ScriptBlock } from '../projects/loopScaffold.js'

const SUITE_HOME = process.env.CYNCO_HOME

afterEach(() => {
  vi.restoreAllMocks()
  setProjectToolContext(null)
  globalContract.clear()
  process.env.CYNCO_HOME = SUITE_HOME
})

/**
 * A CynCo home of the test's own. The loop loads the trust score from
 * `<home>/tool-scores.json` and saves it at the end of every message, so
 * without this one test's failures reach the next test's scorer.
 */
function freshCyncoHome(): void {
  process.env.CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-batch-home-'))
}

/** `notes/note-1.txt` … `notes/note-<n>.txt` under `dir`, each saying which it is. */
function notes(dir: string, n: number): void {
  mkdirSync(join(dir, 'notes'), { recursive: true })
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, 'notes', `note-${i}.txt`), `this is note number ${i}`)
}

const read = (dir: string, i: number): ScriptBlock => ({ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'notes', `note-${i}.txt`) } })
const results = (events: any[], tool: string) => events.filter(e => e?.type === 'tool.complete' && e.toolName === tool).map(e => String(e.result))
const errors = (events: any[], tool: string) => events.filter(e => e?.type === 'tool.complete' && e.toolName === tool).map(e => e.isError === true)
const halted = (events: any[]) => events.some(e => e?.type === 'message.complete' && e.stopReason === 'halted')

/** Every `[toolgate]` line the loop logs while the test runs. */
function toolgateLines(): string[] {
  const lines: string[] = []
  const real = console.log
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ')
    if (line.startsWith('[toolgate]')) lines.push(line)
    real(...args)
  })
  return lines
}

describe('ToolGating on the live loop: a batch is one decision (F178)', () => {
  it('a project chat reads four files in one batch, then one in each of five calls: every Read runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-batch-'))
    const slug = createProject(home, { name: 'Batch', instructions: '' }).slug
    const dir = projectDir(home, slug)
    notes(dir, 9)
    const gate = toolgateLines()
    const { loop, events } = makeLoop({
      script: [
        [read(dir, 1), read(dir, 2), read(dir, 3), read(dir, 4)],
        [read(dir, 5)],
        [read(dir, 6)],
        [read(dir, 7)],
        [read(dir, 8)],
        [read(dir, 9)],
        [{ type: 'text', text: 'Read them all.' }],
      ],
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(9)
    r.forEach((x, i) => {
      expect(x).not.toMatch(/not available this turn/)
      expect(x).toContain(`this is note number ${i + 1}`)
    })
    expect(gate.filter(l => l.includes('Read'))).toEqual([])
  }, 60000)

  it('a coding session: four Reads in one batch leave Read offered on the next call', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-batch-code-'))
    notes(cwd, 5)
    const { loop, events } = makeLoop({
      cwd,
      script: [
        [read(cwd, 1), read(cwd, 2), read(cwd, 3), read(cwd, 4)],
        [read(cwd, 5)],
        [{ type: 'text', text: 'Read them all.' }],
      ],
    })
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(5)
    r.forEach((x, i) => {
      expect(x).not.toMatch(/not available this turn/)
      expect(x).toContain(`this is note number ${i + 1}`)
    })
  }, 60000)

  it('a coding session that reads in four model calls in a row still has Read withheld on the fifth (missions unchanged)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-batch-code-'))
    notes(cwd, 5)
    const gate = toolgateLines()
    const { loop, events } = makeLoop({
      cwd,
      script: [
        [read(cwd, 1)],
        [read(cwd, 2)],
        [read(cwd, 3)],
        [read(cwd, 4)],
        [read(cwd, 5)],
        [{ type: 'text', text: 'Stopping.' }],
      ],
    })
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(5)
    r.slice(0, 4).forEach((x, i) => expect(x).toContain(`this is note number ${i + 1}`))
    expect(r[4]).toMatch(/not available this turn/)
    expect(gate).toContain('[toolgate] Attenuated overused tools: Read')
  }, 60000)
})

/** The real loop bound to a fresh project (`dir` is its folder), driven by the scripted model. */
async function projectChat(script: (dir: string) => ScriptBlock[][]) {
  const home = mkdtempSync(join(tmpdir(), 'cynco-batch-'))
  const slug = createProject(home, { name: 'Batch', instructions: '' }).slug
  const dir = projectDir(home, slug)
  const made = makeLoop({ script: script(dir) })
  const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
  if (!b.ok) throw new Error(b.reason)
  await made.loop.startProjectSession(b.binding, b.messages)
  return { ...made, dir }
}

/** A Read of the folder `<dir>/<name>` (made here): a failure that counts — not a wrong path, which counts for nothing. */
function readFolder(dir: string, name: string): ScriptBlock {
  mkdirSync(join(dir, name), { recursive: true })
  return { type: 'tool_use', name: 'Read', input: { file_path: join(dir, name) } }
}

describe('the trust score on the live loop: a batch is one decision (F178)', () => {
  it('three failed Edits in one call, then a good Edit in the next: the fourth Edit runs and Edit is not demoted', async () => {
    freshCyncoHome()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-batch-trust-'))
    const file = join(cwd, 'real.txt')
    writeFileSync(file, 'the real note\n')
    // A real failure, not a wrong path: the file exists and the text does not.
    const miss = (tag: string): ScriptBlock => ({ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: `text ${tag} that is not in the file`, new_string: 'x' } })
    const { loop, events } = makeLoop({
      cwd,
      script: [
        [miss('a'), miss('b'), miss('c')],
        [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'the real note', new_string: 'the edited note' } }],
        [{ type: 'text', text: 'Edited.' }],
      ],
    })
    const scorer = loop.getExecutor().getToolScorer()!
    await loop.handleUserMessage('change the note')
    const r = results(events, 'Edit')
    expect(r).toHaveLength(4)
    expect(errors(events, 'Edit')).toEqual([true, true, true, false])
    expect(r[3]).not.toMatch(/not available this turn/)
    expect(readFileSync(file, 'utf8')).toContain('the edited note')
    // Scored per call: one failure (the batch) and one success. Scored per
    // call in the batch it was 1 of 4 (0.33, under the 0.35 threshold), and
    // Edit was withheld from the second call before it could run.
    expect(scorer.shouldDemote('Edit')).toBe(false)
    expect(scorer.getConfidence('Edit')).toBeCloseTo((1 + 1) / (2 + 2), 5)
  }, 60000)
})

describe('the trust score never withholds Read in a project chat (F178)', () => {
  /** One good batch of three Reads, then a folder Read (a counted failure) beside a Grep in each of three calls, then a Read. */
  const script = (dir: string): ScriptBlock[][] => {
    notes(dir, 4)
    const grep: ScriptBlock = { type: 'tool_use', name: 'Grep', input: { pattern: 'note', path: join(dir, 'notes') } }
    return [
      [read(dir, 1), read(dir, 2), read(dir, 3)],
      [readFolder(dir, 'fa'), grep], [readFolder(dir, 'fb'), grep], [readFolder(dir, 'fc'), grep],
      [read(dir, 4)],
      [{ type: 'text', text: 'Read it.' }],
    ]
  }

  it('a project chat: one call of good Reads, three calls with a failing Read, then a Read — it runs (Read is 1 of 4 on the score, under the threshold, and still offered)', async () => {
    freshCyncoHome()
    const trustLines: string[] = []
    const real = console.log
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ')
      if (line.startsWith('[trust]')) trustLines.push(line)
      real(...args)
    })
    const { loop, events } = await projectChat(script)
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(7)
    expect(r[6]).toContain('this is note number 4')
    expect(r.some(x => /not available this turn/.test(x))).toBe(false)
    // The score did fall under the threshold; the project chat kept Read offered anyway.
    expect(trustLines).toContain('[trust] Read stays offered in a project chat (its score is under the threshold)')
    expect(trustLines.some(l => l.startsWith('[trust] Demoted tools excluded:') && l.includes('Read'))).toBe(false)
  }, 60000)

  it('a coding session with the same script still has Read withheld after it (missions unchanged)', async () => {
    freshCyncoHome()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-batch-trust-code-'))
    const { loop, events } = makeLoop({ cwd, script: script(cwd) })
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r[r.length - 1]).toMatch(/not available this turn/)
  }, 60000)
})

describe('the algedonic kill switch on the live loop: one pain per tool per model call (F178)', () => {
  it('a project chat reads five folders in one batch: one pain, not five — no halt, and the next call runs', async () => {
    freshCyncoHome()
    const { loop, events, calls, dir } = await projectChat(dir => {
      notes(dir, 1)
      return [
        ['f1', 'f2', 'f3', 'f4', 'f5'].map(name => readFolder(dir, name)),
        [read(dir, 1)],
        [{ type: 'text', text: 'Read it.' }],
      ]
    })
    await loop.handleUserMessage('what do the notes say?')
    expect(halted(events)).toBe(false)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    const r = results(events, 'Read')
    expect(r).toHaveLength(6)
    expect(errors(events, 'Read')).toEqual([true, true, true, true, true, false])
    for (const x of r.slice(0, 5)) expect(x).not.toMatch(/CIRCUIT BREAKER/)
    expect(r[5]).toContain('this is note number 1')
  }, 60000)

  it('a success in the middle of a call resets the streak, so the same tool failing again after it is a pain again', async () => {
    // [Read folder, good Write, Read folder] then a failing folder Read in each of four
    // calls: the call ends on a counted failure, so the streak is 1 after it and the
    // fourth later call makes five. Treating the second Read as a repeat made it six.
    freshCyncoHome()
    const { loop, events, calls } = await projectChat(dir => {
      const write: ScriptBlock = { type: 'tool_use', name: 'Write', input: { file_path: join(dir, 'scratch.txt'), content: 'hello\n' } }
      return [
        [readFolder(dir, 'a1'), write, readFolder(dir, 'a2')],
        [readFolder(dir, 'b')], [readFolder(dir, 'c')], [readFolder(dir, 'd')], [readFolder(dir, 'e')],
        [readFolder(dir, 'f')],
        [{ type: 'text', text: 'never reached' }],
      ]
    })
    const scorer = loop.getExecutor().getToolScorer()!
    for (let i = 0; i < 20; i++) scorer.record('Read', true)
    await loop.handleUserMessage('read the folders')
    expect(halted(events)).toBe(true)
    expect(calls).toHaveLength(5)
  }, 60000)

  it('the breaker: a good Edit between two failed ones in a call leaves one strike, and two more failing calls trip it', async () => {
    freshCyncoHome()
    const { loop, events } = await projectChat(dir => {
      writeFileSync(join(dir, 'real.txt'), 'the real note\n')
      const file = join(dir, 'real.txt')
      const miss = (tag: string): ScriptBlock => ({ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: `text ${tag} that is not in the file`, new_string: 'x' } })
      const ok: ScriptBlock = { type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'the real note', new_string: 'the real note, edited' } }
      return [[miss('a'), ok, miss('b')], [miss('c')], [miss('d')], [{ type: 'text', text: 'Stopping.' }]]
    })
    await loop.handleUserMessage('change the note')
    const r = results(events, 'Edit')
    expect(r).toHaveLength(5)
    for (const x of r.slice(0, 4)) expect(x).not.toMatch(/CIRCUIT BREAKER/)
    expect(r[4]).toMatch(/CIRCUIT BREAKER: Edit has failed 3 consecutive times/)
  }, 60000)

  it('a failing Read on a folder in each of five model calls still halts the session: the switch counts across calls', async () => {
    freshCyncoHome()
    const { loop, events, calls } = await projectChat(dir => [
      [readFolder(dir, 'f1')],
      [readFolder(dir, 'f2')],
      [readFolder(dir, 'f3')],
      [readFolder(dir, 'f4')],
      [readFolder(dir, 'f5')],
      [{ type: 'text', text: 'never reached' }],
    ])
    // A Read with a long good record, so the trust score (three straight
    // failures demote a tool) does not withhold Read before the fifth call.
    const scorer = loop.getExecutor().getToolScorer()!
    for (let i = 0; i < 20; i++) scorer.record('Read', true)
    await loop.handleUserMessage('read the folders')
    expect(errors(events, 'Read')).toEqual([true, true, true, true, true])
    expect(halted(events)).toBe(true)
    expect(calls).toHaveLength(5)
  }, 60000)
})
