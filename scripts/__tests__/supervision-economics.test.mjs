/**
 * The supervision-economics instrument (scripts/supervision-economics.mjs).
 *
 * F239: the campaign log's supervising spend fell from $4,295.55 to $2,995.57
 * between two waves. The script summed whatever Claude Code transcripts were
 * left in ONE project folder and set that against the WHOLE mission ledger.
 * Claude Code removes old transcripts, and a session run in a git worktree is
 * written to another folder, so the sum shrank while the ledger grew. These
 * tests pin the three repairs: every folder of the repository is read, the
 * verdict is taken over the days both sides can still be read, and a verdict
 * that cannot be computed prints no dollar figure a reader could carry away.
 *
 * And the owner's decision of 2026-11-17 (row 15): which repositories are
 * supervised comes from the ledger and the campaign specs, not from one path.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  transcriptFolders, supervisedRoots, rootPattern, classifierFor, readFrontier,
  campaignOf, localSide, verdictWindow, verdictLines, readLedger,
} from '../supervision-economics.mjs'
import { parseSupervisionDollars } from '../cynco-scoreboard.mjs'
import { economicsLines } from '../cynco-campaign-verdict.mjs'

const SLUG = 'C--Users-civer-localcode'

describe('which transcript folders are the repository\'s', () => {
  const names = [
    'C--Users-civer-casino',
    `${SLUG}--claude-worktrees-phone-finish-caad48`,
    SLUG,
    `${SLUG}--claude-worktrees-glm5-review-53a2ad`,
    'C--Users-civer-localcode-old', // another project whose name merely starts the same way
  ]
  it('its own folder first, then one per worktree, and no other project', () => {
    expect(transcriptFolders('P', SLUG, () => names)).toEqual([
      join('P', SLUG),
      join('P', `${SLUG}--claude-worktrees-glm5-review-53a2ad`),
      join('P', `${SLUG}--claude-worktrees-phone-finish-caad48`),
    ])
  })
  it('no projects folder at all is no folders, not a crash', () => {
    expect(transcriptFolders('P', SLUG, () => { throw new Error('ENOENT') })).toEqual([])
  })
})

describe('which repositories are supervised', () => {
  const rows = [
    { cwd: 'C:\\Users\\civer\\civkings' }, { cwd: 'C:/Users/civer/civkings' }, { cwd: 'C:/Users/civer/casino/' },
    { cwd: 'C:/Users/civer/localcode' }, { cwd: 'C:/Users/civer/localcode/.claude/worktrees/x' }, { cwd: '' }, {},
  ]
  it('every ledger cwd and every campaign spec repo, once, whatever the slashes or case', () => {
    expect(supervisedRoots({ rows, specRepos: ['c:/users/civer/CIVKINGS', 'D:/work/shop'], selfRoot: 'C:/Users/civer/localcode' }))
      .toEqual(['C:/Users/civer/casino', 'C:/Users/civer/civkings', 'D:/work/shop'])
  })
  it('this repository is never one, nor anything inside or around it: development must stay development', () => {
    const roots = supervisedRoots({ rows: [{ cwd: 'C:/Users/civer/localcode' }, { cwd: 'C:/Users/civer/localcode/engine' }, { cwd: 'C:/Users/civer' }], selfRoot: 'C:/Users/civer/localcode' })
    expect(roots).toEqual([])
  })
})

describe('the classifier', () => {
  const tool = (input) => [{ type: 'tool_use', input }]
  const { classifyMessage } = classifierFor(['C:/Users/civer/casino'])

  it('a tool call into a supervised repository is supervision, in either spelling of a Windows path', () => {
    expect(classifyMessage(tool({ file_path: 'C:/Users/civer/casino/app/main.py' }))).toBe('supervision')
    // JSON encodes each backslash as two: the pattern has to span them.
    expect(classifyMessage(tool({ command: 'git -C C:\\Users\\civer\\casino log' }))).toBe('supervision')
    expect(rootPattern('C:/Users/civer/casino').test(JSON.stringify({ p: 'C:\\Users\\civer\\casino\\x' }))).toBe(true)
  })
  it('a repository nobody dispatched into is not: without the root the same call is unclassified', () => {
    expect(classifierFor([]).classifyMessage(tool({ file_path: 'C:/Users/civer/casino/app/main.py' }))).toBeNull()
    expect(classifyMessage(tool({ file_path: 'C:/Users/civer/casinofloor/app/main.py' }))).toBeNull() // another repository whose name merely starts the same way
  })
  it('the fixed supervision targets and the development targets are what they were', () => {
    expect(classifyMessage(tool({ command: 'bash scripts/dispatch-mission.sh brief' }))).toBe('supervision')
    expect(classifyMessage(tool({ file_path: 'docs/cynco-failure-log.md' }))).toBe('supervision')
    expect(classifyMessage(tool({ file_path: 'engine/bridge/conversationLoop.ts' }))).toBe('development')
    expect(classifyMessage(tool({ command: 'ls' }))).toBeNull()
    expect(classifyMessage('plain text')).toBeNull()
  })
  it('supervision wins inside one message', () => {
    expect(classifyMessage([{ type: 'tool_use', input: { file_path: 'engine/x.ts' } }, { type: 'tool_use', input: { file_path: 'C:/Users/civer/casino/a' } }])).toBe('supervision')
  })
})

/** One assistant line of a transcript. */
const msg = (day, input, usage = { input_tokens: 1000, output_tokens: 1000 }) => JSON.stringify({
  type: 'assistant', timestamp: `${day}T10:00:00Z`,
  message: { content: input ? [{ type: 'tool_use', input }] : [{ type: 'text', text: 'ok' }], usage },
})

describe('the frontier side', () => {
  const files = {
    [join('A', 's1.jsonl')]: [msg('2026-11-09', { file_path: 'engine/a.ts' }), msg('2026-11-10', null), 'not json', ''].join('\n'),
    [join('B', 's2.jsonl')]: [msg('2026-11-06', { file_path: 'C:/Users/civer/casino/a.py' }), msg('2026-11-14', null)].join('\n'),
  }
  const io = {
    ls: (dir) => { if (dir === 'gone') throw new Error('ENOENT'); return dir === 'empty' ? [] : Object.keys(files).filter(p => p.startsWith(dir)).map(p => p.slice(dir.length + 1)).concat('notes.txt') },
    read: (p) => files[p],
  }
  const { classifyMessage } = classifierFor(['C:/Users/civer/casino'])

  it('reads every folder it is given and says what it read', () => {
    const { byDay, coverage } = readFrontier(['A', 'B', 'empty', 'gone'], classifyMessage, io)
    expect(coverage).toEqual({ folders: 2, transcripts: 2, firstDay: '2026-11-06', lastDay: '2026-11-14' })
    expect([...byDay.keys()].sort()).toEqual(['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-14'])
  })
  it('a worktree session counts: read from the main folder alone, its supervision is simply absent', () => {
    const all = readFrontier(['A', 'B'], classifyMessage, io).byDay
    const mainOnly = readFrontier(['A'], classifyMessage, io).byDay
    expect(all.get('2026-11-06').supervision.msgs).toBe(1)
    expect(mainOnly.has('2026-11-06')).toBe(false)
  })
  it('a text-only message takes the class its session was last in', () => {
    const { byDay } = readFrontier(['A', 'B'], classifyMessage, io)
    expect(byDay.get('2026-11-10').development.msgs).toBe(1)
    expect(byDay.get('2026-11-14').supervision.msgs).toBe(1)
  })
})

describe('which campaign a ledger row belongs to', () => {
  it('its campaignId, or the id its mission id starts with', () => {
    expect(campaignOf({ campaignId: 'c11', missionId: 'c11-wave2-1791237906699' })).toBe('c11')
    expect(campaignOf({ missionId: 'c8-wave3-1789000000000' })).toBe('c8')
    // The old pattern was ^(c\d)- : a two-digit campaign matched nothing and was filed under "other".
    expect(campaignOf({ missionId: 'c10-wave1-1790000000000' })).toBe('c10')
    expect(campaignOf({ missionId: 'casino2-wave1-1790000000000' })).toBe('casino2')
    expect(campaignOf({ missionId: '6b-wave1-1' })).toBeNull()
    expect(campaignOf({ missionId: 'mission_11' })).toBeNull()
    expect(campaignOf({})).toBeNull()
  })
})

describe('which ledger files are read', () => {
  it('the numbered shards, and not the frozen first one: the instrument has never counted it', () => {
    const files = {
      'missions.jsonl': JSON.stringify({ missionId: 'old-1' }),
      'missions.0002.jsonl': [JSON.stringify({ missionId: 'c1-wave1-1' }), '{"torn', ''].join('\n'),
      'missions.0003.jsonl': JSON.stringify({ missionId: 'c2-wave1-2' }),
      'frozen-eval.json': '{}',
      'README.md': '# ledger',
    }
    const rows = readLedger('L', { ls: () => Object.keys(files), read: (p) => files[p.slice(2)] })
    expect(rows.map(r => r.missionId)).toEqual(['c1-wave1-1', 'c2-wave1-2'])
  })
  it('no ledger folder is no rows', () => {
    expect(readLedger('L', { ls: () => { throw new Error('ENOENT') }, read: () => '' })).toEqual([])
  })
})

const mission = (day, id, extra = {}) => ({
  missionId: id, dispatchedAt: `${day}T08:00:00Z`, durationS: 3600, turns: [1, 2], toolStats: { total: 5 },
  tokenStats: { decodeTokens: 1_000_000, cachedTokens: 0, prefillTokens: 0, unmeasuredTurns: 0 }, ...extra,
})

describe('the local side', () => {
  const rows = [mission('2026-10-01', 'c10-wave1-1'), mission('2026-11-08', 'c12-wave1-2'), mission('2026-11-09', 'probe-3')]
  it('all of the ledger, by campaign, with the days it spans', () => {
    const all = localSide(rows)
    expect(all.total.missions).toBe(3)
    expect([...all.campaigns.keys()].sort()).toEqual(['c10', 'c12'])
    expect(all.other.missions).toBe(1)
    expect([all.firstDay, all.lastDay]).toEqual(['2026-10-01', '2026-11-09'])
  })
  it('from a day on, only the missions dispatched from that day', () => {
    const win = localSide(rows, '2026-11-08')
    expect(win.total.missions).toBe(2)
    expect(win.campaigns.has('c10')).toBe(false)
  })
})

describe('the window the verdict is taken over', () => {
  it('starts at the first day a transcript still on disk carries', () => {
    expect(verdictWindow({ frontierFirstDay: '2026-11-06' }).from).toBe('2026-11-06')
  })
  it('--since moves it later, never earlier than the transcripts reach', () => {
    expect(verdictWindow({ since: '2026-11-10', frontierFirstDay: '2026-11-06' })).toMatchObject({ from: '2026-11-10' })
    const early = verdictWindow({ since: '2026-08-01', frontierFirstDay: '2026-11-06' })
    expect(early.from).toBe('2026-11-06')
    expect(early.why).toContain('later than --since 2026-08-01')
  })
  it('there is none without a transcript', () => {
    expect(verdictWindow({ frontierFirstDay: null }).from).toBeNull()
  })
})

describe('the verdict', () => {
  const usage = (output) => ({ input: 0, output, cacheWrite: 0, cacheRead: 0, msgs: 1 })
  const totals = { supervision: usage(1_000_000), development: usage(2_000_000), unattributed: usage(0) }
  const coverage = { folders: 2, transcripts: 5, firstDay: '2026-11-06', lastDay: '2026-11-17' }
  const window = verdictWindow({ frontierFirstDay: coverage.firstDay })

  it('today\'s real case: the ledger ends before the transcripts begin, so there is no figure at all', () => {
    const rows = [mission('2026-08-15', 'c1-wave1-1'), mission('2026-10-05', 'c11-wave2-2')]
    const lines = verdictLines({ window, coverage, ledger: localSide(rows), inWindow: localSide(rows, window.from), frontierTotals: totals })
    expect(lines[0]).toBe('VERDICT: not computable. No mission in the ledger was dispatched on a day the frontier transcripts still cover (transcripts on disk: 2026-11-06 to 2026-11-17; ledger: 2026-08-15 to 2026-10-05).')
    const text = lines.join(' ')
    expect(text).toContain('F239')
    expect(text).not.toMatch(/\$\d/)
    // What the campaign scoreboard does with it: no SUPERVISING figure, so "unmeasured", never a number.
    expect(parseSupervisionDollars(lines)).toBeNull()
  })

  it('missions inside the window are set against the supervision of the same days, and the rest are named as left out', () => {
    const rows = [mission('2026-10-05', 'c11-wave2-1'), mission('2026-11-08', 'c12-wave1-2'), mission('2026-11-12', 'c12-wave2-3')]
    const lines = verdictLines({ window, coverage, ledger: localSide(rows), inWindow: localSide(rows, window.from), frontierTotals: totals })
    // 1M output tokens at $75/MTok of supervision; two missions of 1M decode tokens each = $150 of generation.
    expect(lines[0]).toBe('VERDICT: from 2026-11-06 on, frontier spent $75.00 SUPERVISING (development $150.00 and')
    expect(lines).toContain('supervision ratio: $1 of frontier verify oversees ~$2.00 of displaced generation.')
    expect(lines.join(' ')).toContain('This counts 2 mission(s) dispatched from 2026-11-06 on')
    expect(lines.join(' ')).toContain('1 earlier one(s) are left out')
    expect(lines.join(' ')).toContain('It is not a running total.')
    expect(parseSupervisionDollars(lines)).toBe(75)
  })

  it('says how much of the supervising spend came after the last counted mission, in dollars', () => {
    const rows = [mission('2026-11-08', 'c12-wave1-2'), mission('2026-11-12', 'c12-wave2-3')]
    // $75 in the window in all, $30 of it (400k output tokens) on or before the last mission's day.
    const lines = verdictLines({ window, coverage, ledger: localSide(rows), inWindow: localSide(rows, window.from), frontierTotals: totals, supervisionToLastMission: usage(400_000) })
    expect(lines).toContain('Of that supervising spend, $30.00 came on or before 2026-11-12, the day the last counted mission was dispatched ($1 to ~$5.00 on those days alone);')
    expect(lines).toContain('the other $45.00 came after it, with no mission to oversee: the classifier files gate, harness and instrument work as supervision too.')
    // The figure the scoreboard reads is still the window's.
    expect(parseSupervisionDollars(lines)).toBe(75)
  })

  it('when all of it came by the last mission there is nothing to split', () => {
    const rows = [mission('2026-11-17', 'c12-wave1-2')]
    const lines = verdictLines({ window, coverage, ledger: localSide(rows), inWindow: localSide(rows, window.from), frontierTotals: totals, supervisionToLastMission: usage(1_000_000) })
    expect(lines.join(' ')).not.toContain('Of that supervising spend')
  })

  it('no transcript on disk is the same answer: not computable', () => {
    const none = { folders: 0, transcripts: 0, firstDay: null, lastDay: null }
    const rows = [mission('2026-10-05', 'c11-wave2-1')]
    const lines = verdictLines({ window: verdictWindow({ frontierFirstDay: null }), coverage: none, ledger: localSide(rows), inWindow: localSide(rows, '9999-99-99'), frontierTotals: totals })
    expect(lines[0]).toMatch(/^VERDICT: not computable\./)
    expect(lines[0]).toContain('transcripts on disk: none')
  })

  it('the campaign runner still finds the section: it starts at the line that begins "VERDICT:"', () => {
    const rows = [mission('2026-11-08', 'c12-wave1-2')]
    const section = verdictLines({ window, coverage, ledger: localSide(rows), inWindow: localSide(rows, window.from), frontierTotals: totals })
    const report = ['COVERAGE (what each side can still be read for):', '  frontier: 5 transcript(s)', '', ...section].join('\n')
    expect(economicsLines({ run: () => report })).toEqual(section)
  })
})
