import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STEPS, TOTAL, DEFAULT_BASE, PROJECT_LAYOUT, COOKBOOK_CHAPTER, PDF_PAGES, PROMPTS,
  smokeLine, statusMessage, expectStatus, SmokeFailure, readDashboardToken, missingLayout,
  knowledgeCitations, saidDenied, namesDir, namesAnyOf, phraseFrom, replyText,
} from '../projects-smoke.mjs'

describe('projects-smoke: the step list', () => {
  it('has the eleven steps of the brief, numbered 1..11 in order', () => {
    expect(TOTAL).toBe(11)
    expect(STEPS.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(STEPS.map(s => s.name)).toEqual([
      'create project', 'paste knowledge', 'upload pdf', 'open project', 'chat with citations', 'save artifact',
      'promote artifact', 'global search', 'project isolation', 'download asks', 'leave project',
    ])
  })
  it('defaults to the scratch dashboard port, never the user\'s 9161', () => {
    expect(DEFAULT_BASE).toBe('http://127.0.0.1:19161')
    expect(DEFAULT_BASE).not.toContain(':9161')
  })
  it('pastes a chapter with at least three headings and a two-page PDF about resin curing', () => {
    expect(COOKBOOK_CHAPTER.split('\n').filter(l => /^#{1,3} /.test(l)).length).toBeGreaterThanOrEqual(3)
    expect(COOKBOOK_CHAPTER).toMatch(/Starters/)
    expect(PDF_PAGES).toHaveLength(2)
    expect(PDF_PAGES.join(' ')).toMatch(/24 hours to cure/)
  })
  it('sends the brief\'s prompts verbatim', () => {
    expect(PROMPTS.ask).toBe('Which chapter covers starters, and how long does the PDF say resin takes to cure? Cite the passages.')
    expect(PROMPTS.save).toBe('Save that answer as an artifact named smoke-answer.')
    expect(PROMPTS.isolate).toBe("Use ProjectSearch for 'resin' in this project only and tell me the exact tool output.")
    expect(PROMPTS.download).toBe('Run this command: curl -s https://example.com')
    expect(PROMPTS.cwd).toBe('What directory are you in?')
  })
})

describe('projects-smoke: the assertion messages', () => {
  it('prints one [smoke] n/11 PASS|FAIL line with whitespace folded', () => {
    expect(smokeLine(3, true, 'upload pdf', '201  resin-guide.pdf\nindexed: true')).toBe('[smoke] 3/11 PASS upload pdf: 201 resin-guide.pdf indexed: true')
    expect(smokeLine(10, false, 'download asks', 'no approval.request')).toBe('[smoke] 10/11 FAIL download asks: no approval.request')
  })
  it('names the route, the status it got and the one it wanted', () => {
    expect(statusMessage('POST /api/projects', 201, 201, {})).toBeNull()
    expect(statusMessage('POST /api/projects', 400, 201, { error: 'name is required' })).toBe('POST /api/projects answered 400, expected 201 — {"error":"name is required"}')
    expect(statusMessage('GET x', 503, 200, null)).toBe('GET x answered 503, expected 200 — null')
    expect(() => expectStatus('GET x', 404, 200, { error: 'no such project' })).toThrow(SmokeFailure)
    expect(() => expectStatus('GET x', 200, 200, {})).not.toThrow()
  })
})

describe('projects-smoke: the token reader', () => {
  it('returns the dashboard secret and never another token', () => {
    const read = () => JSON.stringify({ version: 1, tokens: [{ name: 'tui', secret: 'T' }, { name: 'dashboard', scopes: ['inference'], secret: 'D' }, { name: 'admin', secret: 'A' }] })
    expect(readDashboardToken('C:/h', read)).toBe('D')
  })
  it('names the file when there is no dashboard token or the file is unreadable', () => {
    expect(() => readDashboardToken('C:/h', () => JSON.stringify({ tokens: [{ name: 'tui', secret: 'T' }] }))).toThrow(/no 'dashboard' token in .*tokens\.json/)
    expect(() => readDashboardToken('C:/h', () => { throw new Error('ENOENT') })).toThrow(/cannot read .*tokens\.json: ENOENT/)
    expect(() => readDashboardToken('C:/h', () => '{not json')).toThrow(/cannot read/)
  })
  it('reads a real tokens.json on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-tok-'))
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ tokens: [{ name: 'dashboard', secret: 'on-disk' }] }))
    expect(readDashboardToken(dir)).toBe('on-disk')
  })
})

describe('projects-smoke: the checks', () => {
  it('lists every missing layout entry, and none for a whole folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-layout-'))
    expect(missingLayout(dir)).toEqual(PROJECT_LAYOUT)
    for (const rel of PROJECT_LAYOUT) {
      if (/\.(json|md)$|^\.gitignore$/.test(rel)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), '') } else mkdirSync(join(dir, rel), { recursive: true })
    }
    expect(missingLayout(dir)).toEqual([])
  })
  it('keeps only citations under knowledge/', () => {
    const c = [{ n: 1, filePath: 'knowledge/a.md' }, { n: 2, filePath: 'artifacts/b.md' }, { n: 3, filePath: 'chats/c.jsonl' }, null]
    expect(knowledgeCitations(c).map(x => x.n)).toEqual([1])
    expect(knowledgeCitations(undefined)).toEqual([])
  })
  it('recognises a denial and not a run', () => {
    expect(saidDenied('The command was denied, so I could not fetch the page.')).toBe(true)
    expect(saidDenied('You declined the approval.')).toBe(true)
    expect(saidDenied('It was not approved.')).toBe(true)
    expect(saidDenied('Here is the HTML of example.com: <h1>Example Domain</h1>')).toBe(false)
  })
  it('matches a directory by full path in either slash style, or by its last segment', () => {
    const cwd = 'C:\\Users\\civer\\localcode\\.claude\\worktrees\\projects-mode'
    expect(namesDir('I am in `C:/Users/civer/localcode/.claude/worktrees/projects-mode`.', cwd)).toBe(true)
    expect(namesDir('I am in C:\\\\Users\\\\civer\\\\localcode\\\\.claude\\\\worktrees\\\\projects-mode', cwd)).toBe(true)
    expect(namesDir('The working directory is projects-mode.', cwd)).toBe(true)
    expect(namesDir('I am in C:/scratch/other-test', cwd)).toBe(false)
  })
  it('names which forbidden paths or slugs a reply mentions', () => {
    expect(namesAnyOf('found in diorama-test/knowledge', ['diorama-test', 'zzz'])).toEqual(['diorama-test'])
    expect(namesAnyOf('nothing here', ['diorama-test'])).toEqual([])
    expect(namesAnyOf('C:/tmp/home/other-test', ['C:\\tmp\\home'])).toEqual(['C:\\tmp\\home'])
  })
  it('picks the longest plain-word line as the search phrase', () => {
    const t = '# Answer\n\n**Starters** are in Chapter 3 [1]; resin takes 24 hours to cure [2].\nok'
    expect(phraseFrom(t)).toBe('Starters are in Chapter 3 resin takes 24')
    expect(phraseFrom('', 8)).toBe('')
  })
  it('joins only stream.token text into the reply', () => {
    expect(replyText([{ type: 'stream.thinking', text: 'x' }, { type: 'stream.token', text: 'Hel' }, { type: 'tool.start' }, { type: 'stream.token', text: 'lo' }])).toBe('Hello')
  })
})
