/**
 * The project journal is the engine's own file, but the model can write
 * anywhere in a project — `gradeProjectCall` grades `ln -s` as safe — so
 * `journal.md` may be a link, a folder or a FIFO by the time the engine
 * appends to it (review of F174, the same class as the image store's planted
 * links). An append must never follow a link out of the project, and a read
 * must never block the engine's thread on a FIFO or swallow a huge file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, lstatSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, appendJournal, readJournal, JOURNAL_READ_CAP } from '../../projects/layout.js'
import { canSymlinkFiles } from '../imagegen/mockComfy.js'

let home: string
let outside: string
let logs: string[]
const realLog = console.log
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-journal-'))
  outside = mkdtempSync(join(tmpdir(), 'cynco-journal-outside-'))
  logs = []
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
})
afterEach(() => {
  console.log = realLog
  rmSync(home, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function project(): string {
  const meta = createProject(home, { name: 'Fence' })
  return join(home, meta.slug)
}

describe('appendJournal never writes through a planted journal.md', () => {
  it.skipIf(!canSymlinkFiles())('a link to a file outside the project: the outside file is untouched, the line is dropped with a named reason, the link is left alone', () => {
    const dir = project()
    const target = join(outside, 'victim.txt')
    writeFileSync(target, 'keep\n', 'utf8')
    rmSync(join(dir, 'journal.md'))
    symlinkSync(target, join(dir, 'journal.md'))
    expect(() => appendJournal(dir, 'artifact.saved', 'x', () => '2026-10-12T00:00:00.000Z')).not.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('keep\n')
    expect(lstatSync(join(dir, 'journal.md')).isSymbolicLink()).toBe(true)
    expect(logs.some(l => /\[projects\] journal\.md .*is a link.*not written/.test(l))).toBe(true)
    // and the read side does not follow it either
    expect(readJournal(dir)).toEqual([])
  })

  it('a folder at journal.md: nothing is written, the reason is logged, nothing is removed', () => {
    const dir = project()
    rmSync(join(dir, 'journal.md'))
    mkdirSync(join(dir, 'journal.md'))
    writeFileSync(join(dir, 'journal.md', 'inner.txt'), 'inner\n', 'utf8')
    expect(() => appendJournal(dir, 'chat.opened', 'c1')).not.toThrow()
    expect(existsSync(join(dir, 'journal.md', 'inner.txt'))).toBe(true)
    expect(logs.some(l => /\[projects\] journal\.md .*not a regular file.*not written/.test(l))).toBe(true)
    expect(readJournal(dir)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a FIFO at journal.md: neither the append nor the read blocks', () => {
    const dir = project()
    rmSync(join(dir, 'journal.md'))
    execFileSync('mkfifo', [join(dir, 'journal.md')])
    const t0 = Date.now()
    expect(() => appendJournal(dir, 'knowledge.added', 'a.md')).not.toThrow()
    expect(readJournal(dir)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(logs.some(l => /\[projects\] journal\.md .*not a regular file/.test(l))).toBe(true)
  }, 5000)

  it('a regular journal.md still takes the line and reads back newest first', () => {
    const dir = project()
    let n = 0
    const now = () => `2026-10-12T00:00:0${n++}.000Z`
    appendJournal(dir, 'knowledge.added', 'a.md', now)
    appendJournal(dir, 'artifact.saved', 'b.md', now)
    expect(readJournal(dir, 2).map(e => e.event)).toEqual(['artifact.saved', 'knowledge.added'])
    expect(logs.filter(l => l.startsWith('[projects] journal.md'))).toEqual([])
  })

  it('an absent journal.md is created by the append (a project made before the file existed)', () => {
    const dir = project()
    rmSync(join(dir, 'journal.md'))
    appendJournal(dir, 'created', 'again', () => '2026-10-12T00:00:00.000Z')
    expect(readJournal(dir)).toEqual([{ at: '2026-10-12T00:00:00.000Z', event: 'created', detail: 'again' }])
  })
})

describe('readJournal reads only a regular file, and only its tail past the cap', () => {
  it('a journal over the cap yields its newest lines, never the whole file, and the cut first line is dropped', () => {
    const dir = project()
    const line = (i: number) => `- 2026-10-12T00:00:00.000Z event.${i} — ${'d'.repeat(200)}\n`
    const chunks: string[] = []
    let bytes = 0
    for (let i = 0; bytes <= JOURNAL_READ_CAP + 10_000; i++) { const l = line(i); chunks.push(l); bytes += Buffer.byteLength(l) }
    writeFileSync(join(dir, 'journal.md'), chunks.join(''), 'utf8')
    const got = readJournal(dir, 5)
    expect(got).toHaveLength(5)
    expect(got[0].event).toBe(`event.${chunks.length - 1}`)
    // every returned detail is whole: the partial line at the cut was dropped
    for (const e of got) expect(e.detail).toBe('d'.repeat(200))
    expect(logs.some(l => /\[projects\] journal\.md .*over the .* cap; reading its tail/.test(l))).toBe(true)
  })
})
