import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { newChatFile, appendTranscript, readTranscript, listChats, renameChat, titleFrom, turnsOf } from '../../projects/chat.js'

let dir: string
beforeEach(() => { const home = mkdtempSync(join(tmpdir(), 'cynco-chat-')); dir = join(home, createProject(home, { name: 'C' }).slug) })
afterEach(() => { rmSync(join(dir, '..'), { recursive: true, force: true }) })

describe('chat transcripts', () => {
  it('names the file by a filesystem-safe timestamp and the title slug, writes the header first', () => {
    const { file, header } = newChatFile(dir, '  How much   resin do I need for a 60×40 base? and more words to push past sixty characters', new Date('2026-10-05T12:34:56Z'))
    // `slugify` (layout.ts) always strips a trailing hyphen, so a title that is
    // cut to exactly 60 chars at a word boundary produces no trailing "-" before
    // the extension.
    expect(file).toMatch(/^20261005T123456-how-much-resin-do-i-need-for-a-60-40-base-and-more-words-to\.jsonl$/)
    expect(header).toMatchObject({ kind: 'chat', projectSlug: 'c', createdAt: '2026-10-05T12:34:56.000Z' })
    expect(header.title).toBe(titleFrom('  How much   resin do I need for a 60×40 base? and more words to push past sixty characters'))
    expect(header.title.length).toBeLessThanOrEqual(60)
    expect(readFileSync(join(dir, 'chats', file), 'utf8').split('\n')[0]).toBe(JSON.stringify(header))
  })
  it('appends one line per message and reads them back; an aborted flag survives', () => {
    const { file } = newChatFile(dir, 'q')
    appendTranscript(dir, file, { role: 'user', content: [{ type: 'text', text: 'q' }] })
    appendTranscript(dir, file, { role: 'assistant', content: [{ type: 'text', text: 'partial' }], aborted: true })
    const t = readTranscript(dir, file)!
    expect(t.messages).toHaveLength(2)
    expect(t.messages[1].aborted).toBe(true)
    expect(readTranscript(dir, 'missing.jsonl')).toBeNull()
  })
  it('lists chats newest first with message counts and renames in place', () => {
    const a = newChatFile(dir, 'first', new Date('2026-10-05T10:00:00Z'))
    const b = newChatFile(dir, 'second', new Date('2026-10-05T11:00:00Z'))
    appendTranscript(dir, b.file, { role: 'user', content: [{ type: 'text', text: 'second' }] })
    expect(listChats(dir).map(c => [c.file, c.messages])).toEqual([[b.file, 1], [a.file, 0]])
    expect(renameChat(dir, a.file, 'Resin maths')).toBe(true)
    expect(readTranscript(dir, a.file)!.header.title).toBe('Resin maths')
    expect(renameChat(dir, 'nope.jsonl', 'x')).toBe(false)
  })
  it('turnsOf pairs user text with the following assistant text and skips tool-result users', () => {
    const msgs = [
      { role: 'user' as const, content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't', content: 'file' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'a1' }] },
      { role: 'user' as const, content: [{ type: 'text', text: 'q2' }] },
    ]
    expect(turnsOf(msgs)).toEqual([{ user: 'q1', assistant: 'calling\n\na1' }, { user: 'q2', assistant: '' }])
  })
})
