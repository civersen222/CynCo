/**
 * F178 (live run 2026-10-13): asked for the tower designs, the project chat
 * guessed three prompt-file names in one parallel Read batch. Every miss counted
 * as a "consecutive" failure, so the third result was overridden with "CIRCUIT
 * BREAKER … STOP using Read this way … Try a COMPLETELY DIFFERENT approach",
 * the trust score demoted Read, the algedonic channel stood at four of the five
 * pains that halt a session, and the model read its files through Bash
 * `Get-Content`. Two rules come out of it, pinned here on the live loop:
 * - a wrong path is the tool working (its answer lists the folder): it is no
 *   strike, no pain and no failure, wherever the loop counts failures;
 * - a strike is per MODEL CALL: calls the model fired together are one
 *   decision, so a batch of failures is one strike, and a third strike across
 *   calls still trips the breaker.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, projectDir } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { makeLoop, type ScriptBlock } from '../projects/loopScaffold.js'

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

/** A project with a `notes/` folder holding one real file. */
function project() {
  const home = mkdtempSync(join(tmpdir(), 'cynco-breaker-'))
  const slug = createProject(home, { name: 'Breaker', instructions: '' }).slug
  const dir = projectDir(home, slug)
  mkdirSync(join(dir, 'notes'), { recursive: true })
  writeFileSync(join(dir, 'notes', 'real.txt'), 'the real note\n')
  return { home, slug, dir }
}

/** The real loop bound to that project, driven by the scripted model. */
async function bound(home: string, slug: string, script: ScriptBlock[][]) {
  const made = makeLoop({ script, model: 'qwen3.8' })
  const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
  if (!b.ok) throw new Error(b.reason)
  await made.loop.startProjectSession(b.binding, b.messages)
  return made
}

const read = (dir: string, name: string): ScriptBlock => ({ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'notes', name) } })
const editMiss = (dir: string, tag: string): ScriptBlock => ({ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'notes', 'real.txt'), old_string: `text ${tag} that is not in the file`, new_string: 'x' } })
const editOk = (dir: string, from: string, to: string): ScriptBlock => ({ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'notes', 'real.txt'), old_string: from, new_string: to } })
const glob = (dir: string, pattern: string): ScriptBlock => ({ type: 'tool_use', name: 'Glob', input: { pattern, path: join(dir, 'notes') } })
const results = (events: any[], tool: string) => events.filter(e => e?.type === 'tool.complete' && e.toolName === tool).map(e => String(e.result))
const halted = (events: any[]) => events.some(e => e?.type === 'message.complete' && e.stopReason === 'halted')

describe('the tool circuit breaker and the failure counters (F178)', () => {
  it('three misses on three guessed paths in ONE model call: no trip, Read stays offered, the next Read works', async () => {
    const { home, slug, dir } = project()
    const { loop, events } = await bound(home, slug, [
      [read(dir, 'guess-1.txt'), read(dir, 'guess-2.txt'), read(dir, 'guess-3.txt')],
      [read(dir, 'real.txt')],
      [{ type: 'text', text: 'Found it.' }],
    ])
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(4)
    for (const x of r.slice(0, 3)) {
      expect(x).toMatch(/file not found/)
      expect(x).not.toMatch(/CIRCUIT BREAKER/)
    }
    expect(r[3]).toMatch(/the real note/)
  }, 60000)

  it('guessed paths feed no pain: three in a batch then two failed Edits do not reach the five that halt a session', async () => {
    // Run 1 stood at four of five: three guessed Reads and a blocked WebFetch.
    const { home, slug, dir } = project()
    const { loop, events } = await bound(home, slug, [
      [read(dir, 'guess-1.txt'), read(dir, 'guess-2.txt'), read(dir, 'guess-3.txt')],
      [editMiss(dir, 'a')],
      [editMiss(dir, 'b')],
      [read(dir, 'real.txt')],
      [{ type: 'text', text: 'Found it.' }],
    ])
    await loop.handleUserMessage('what do the notes say?')
    expect(halted(events)).toBe(false)
    const r = results(events, 'Read')
    expect(r).toHaveLength(4)
    expect(r[3]).toMatch(/the real note/)
  }, 60000)

  it('a wrong path in each of three model calls is never a strike: no trip, and Read is never withheld', async () => {
    const { home, slug, dir } = project()
    const { loop, events } = await bound(home, slug, [
      [read(dir, 'guess-1.txt')],
      [read(dir, 'guess-2.txt')],
      [read(dir, 'guess-3.txt')],
      [read(dir, 'real.txt')],
      [{ type: 'text', text: 'Found it.' }],
    ])
    await loop.handleUserMessage('what do the notes say?')
    const r = results(events, 'Read')
    expect(r).toHaveLength(4)
    for (const x of r) {
      expect(x).not.toMatch(/CIRCUIT BREAKER/)
      expect(x).not.toMatch(/not available this turn/)
    }
    expect(r[3]).toMatch(/the real note/)
  }, 60000)

  it('a Read that trips for a reason other than a wrong path is sent to Glob, never to Bash', async () => {
    const { home, slug, dir } = project()
    // a folder, not a file — three different ones, so the read-loop gate (which denies a repeat) stays out of it
    const folder = (name: string): ScriptBlock => { mkdirSync(join(dir, name), { recursive: true }); return { type: 'tool_use', name: 'Read', input: { file_path: join(dir, name) } } }
    const { loop, events } = await bound(home, slug, [[folder('notes')], [folder('a')], [folder('b')], [{ type: 'text', text: 'Stopping.' }]])
    await loop.handleUserMessage('read the notes folder')
    const r = results(events, 'Read')
    expect(r).toHaveLength(3)
    for (const x of r.slice(0, 2)) expect(x).not.toMatch(/CIRCUIT BREAKER/)
    expect(r[2]).toMatch(/CIRCUIT BREAKER: Read has failed 3 consecutive times/)
    expect(r[2]).toMatch(/Glob/)
    expect(r[2]).toMatch(/never through Bash/)
    expect(r[2]).not.toMatch(/COMPLETELY DIFFERENT approach/)
  }, 60000)

  it('a failure that counts takes one strike per model call: three in one call are one, a third call trips', async () => {
    // Two good Edits first and a Glob beside each later miss, so neither the trust
    // score (three straight misses demote a tool) nor ToolGating (four straight
    // calls of one tool) withholds Edit before the breaker can be seen.
    const { home, slug, dir } = project()
    const { loop, events } = await bound(home, slug, [
      [editOk(dir, 'the real note', 'the real note one')],
      [editOk(dir, 'note one', 'note two')],
      [glob(dir, '*.txt')],
      [editMiss(dir, '1'), editMiss(dir, '2'), editMiss(dir, '3')], // strike one
      [glob(dir, '*.md'), editMiss(dir, '4')],                      // two
      [glob(dir, '*.json'), editMiss(dir, '5')],                    // three: trips
      [{ type: 'text', text: 'Stopping.' }],
    ])
    await loop.handleUserMessage('change the note')
    expect(halted(events)).toBe(false)
    const r = results(events, 'Edit')
    expect(r).toHaveLength(7)
    for (const x of r.slice(0, 6)) {
      expect(x).not.toMatch(/CIRCUIT BREAKER/)
      expect(x).not.toMatch(/not available this turn/)
    }
    expect(r[6]).toMatch(/CIRCUIT BREAKER: Edit has failed 3 consecutive times/)
    expect(r[6]).toMatch(/COMPLETELY DIFFERENT approach/) // the generic advice, for a tool that is not Read
  }, 60000)
})
