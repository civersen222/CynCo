import { beforeEach, describe, expect, it } from 'vitest'
import {
  betterToolHint,
  codeIndexAdoptionHint,
  looksSemantic,
  resetCodeIndexNudgeState,
  withCodeIndexNudge,
  withToolHint,
} from '../../tools/toolHints.js'

describe('betterToolHint — file reads', () => {
  it('catches the exact PowerShell paging CynCo used eight times in one task', () => {
    const hint = betterToolHint('Get-Content C:\\repo\\gilded\\docket.py | Select-Object -Skip 720 -First 60')
    expect(hint).toContain('Read tool')
  })

  it('catches a bare Get-Content, cat, head and tail', () => {
    for (const cmd of ['Get-Content a.py', 'cat a.py', 'head -50 a.py', 'tail -n 20 a.py']) {
      expect(betterToolHint(cmd), cmd).toContain('Read tool')
    }
  })

  it('catches the form CynCo reached for most — slicing a variable that holds the file', () => {
    // `$content = Get-Content ...; $content[723..741] -join "`n"`. A check that only
    // looks at the leading token of each pipeline stage sees a variable assignment
    // and a bare variable, and misses the read entirely.
    const cmd = '$content = Get-Content "C:\\repo\\gilded\\docket.py"; $content[723..741] -join "`n"'
    expect(betterToolHint(cmd)).toContain('Read tool')
  })

  it('points at Grep, not Read, when the command is searching', () => {
    expect(betterToolHint('Select-String -Path a.py -Pattern "def foo"')).toContain('Grep tool')
    expect(betterToolHint('grep -n "def foo" a.py')).toContain('Grep tool')
    expect(betterToolHint('Get-Content a.py | Select-String "def foo"')).toContain('Grep tool')
  })
})

describe('betterToolHint — source rewrites', () => {
  it('catches the read-modify-write one-liner, and warns that a miss is silent', () => {
    const cmd = `python -c "content = open('docket.py').read(); old = '''def f(): pass'''; open('docket.py','w').write(content.replace(old, 'x'))"`
    const hint = betterToolHint(cmd)
    expect(hint).toContain('Edit')
    // The point of the hint is the silent-success failure mode, not tidiness.
    expect(hint).toContain('UNCHANGED')
  })

  it('needs BOTH a read and a write — reading in a script is fine', () => {
    expect(betterToolHint(`python -c "print(open('a.py').read().count('\\n'))"`)).toBeNull()
  })

  it('leaves a script that only WRITES alone — that is what Write is for', () => {
    expect(betterToolHint(`python -c "open('out.txt','w').write('hello')"`)).toBeNull()
  })
})

describe('betterToolHint — leaves real shell work alone', () => {
  it('says nothing about a test run, a git command, or a build', () => {
    for (const cmd of [
      'python -m pytest gilded/ -q',
      'git status --porcelain',
      'npx vitest run',
      'ls -la',
      'python C:/tmp/verify_l3_2b.py partial_fill',
    ]) {
      expect(betterToolHint(cmd), cmd).toBeNull()
    }
  })

  it('says nothing when the file is input to real work rather than being read out', () => {
    expect(betterToolHint('Get-Content a.py | ForEach-Object { $_.Trim() }')).toBeNull()
    expect(betterToolHint('cat requirements.txt | xargs pip install')).toBeNull()
    expect(betterToolHint('Get-Content a.py | Measure-Object -Line')).toBeNull()
  })

  it('says nothing when a statement after the read does real work', () => {
    // Reading a file into a variable is only a "read" if that is all the call does.
    // Here the file is being loaded for a job, so Read is not the better tool.
    expect(betterToolHint('$data = Get-Content a.py; python analyze.py')).toBeNull()
  })

  it('says nothing when output is redirected — that is a write, not a read', () => {
    expect(betterToolHint('Get-Content a.py > b.py')).toBeNull()
    expect(betterToolHint('cat a.py >> b.py')).toBeNull()
  })

  it('does not mistake a quoted pipe for a pipeline stage', () => {
    // One stage, not two: the `|` is part of the pattern. Misreading this would
    // make the command look like `grep ... | b" a.py`, which matches nothing.
    expect(betterToolHint('grep -n "def a|def b" file.py')).toContain('Grep tool')
  })
})

describe('withToolHint', () => {
  it('prepends the hint and keeps every byte of the output', () => {
    const out = withToolHint('Get-Content a.py', 'line one\nline two')
    expect(out).toContain('Read tool')
    expect(out).toContain('line one\nline two')
  })

  it('returns the output untouched when there is no hint', () => {
    expect(withToolHint('git status', 'clean')).toBe('clean')
  })
})

describe('codeIndexAdoptionHint', () => {
  beforeEach(() => resetCodeIndexNudgeState())

  it('nudges toward CodeIndex when Grep finds nothing, quoting the query', () => {
    const hint = codeIndexAdoptionHint('Grep', { pattern: 'hold_seat' }, 'No matches found', false)
    expect(hint).toContain('CodeIndex')
    expect(hint).toContain('"hold_seat"')
  })

  it('nudges when a Grep pattern is prose, not a regex', () => {
    const hint = codeIndexAdoptionHint(
      'Grep', { pattern: 'where orders are resolved' }, 'game.py:12: ...', false)
    expect(hint).toContain('CodeIndex')
    expect(hint).toContain('"where orders are resolved"')
  })

  it('leaves exact-string and regex Grep calls alone', () => {
    for (const pattern of ['def resolve_combat', 'hold seat', 'foo.*bar', 'orders\[', 'x']) {
      expect(codeIndexAdoptionHint('Grep', { pattern }, 'game.py:12: hit', false), pattern).toBeNull()
    }
  })

  it('says nothing on an errored call — the error is the message', () => {
    expect(codeIndexAdoptionHint('Grep', { pattern: 'how orders work here' }, 'Grep error: boom', true)).toBeNull()
  })

  it('fires the crawl nudge on the 15th retrieval call without CodeIndex, then again at 30', () => {
    for (let i = 1; i <= 14; i++) {
      expect(codeIndexAdoptionHint('Read', {}, 'contents', false), `call ${i}`).toBeNull()
    }
    const at15 = codeIndexAdoptionHint('Read', {}, 'contents', false)
    expect(at15).toContain('15')
    expect(at15).toContain('CodeIndex')
    for (let i = 16; i <= 29; i++) {
      expect(codeIndexAdoptionHint('Glob', {}, 'files', false), `call ${i}`).toBeNull()
    }
    expect(codeIndexAdoptionHint('Read', {}, 'contents', false)).toContain('30')
  })

  it('a CodeIndex call resets the crawl counter', () => {
    for (let i = 1; i <= 14; i++) codeIndexAdoptionHint('Read', {}, 'contents', false)
    expect(codeIndexAdoptionHint('CodeIndex', { query: 'q' }, 'results', false)).toBeNull()
    expect(codeIndexAdoptionHint('Read', {}, 'contents', false)).toBeNull()
  })

  it('non-retrieval tools neither count nor get hints', () => {
    for (let i = 1; i <= 40; i++) {
      expect(codeIndexAdoptionHint('Bash', { command: 'ls' }, 'out', false)).toBeNull()
    }
    expect(codeIndexAdoptionHint('Read', {}, 'contents', false)).toBeNull()
  })
})

describe('looksSemantic', () => {
  it('three or more plain words is a question', () => {
    expect(looksSemantic('where orders are resolved')).toBe(true)
    expect(looksSemantic('how turn processing works')).toBe(true)
  })

  it('regex metacharacters mean they meant regex', () => {
    expect(looksSemantic('def [a-z]+ resolve')).toBe(false)
    expect(looksSemantic('one two three.*')).toBe(false)
  })

  it('one or two words is an exact-string search', () => {
    expect(looksSemantic('hold_seat')).toBe(false)
    expect(looksSemantic('hold seat')).toBe(false)
  })
})

describe('withCodeIndexNudge', () => {
  beforeEach(() => resetCodeIndexNudgeState())

  it('prepends the hint and keeps every byte of the output', () => {
    const out = withCodeIndexNudge('Grep', { pattern: 'ghost_function' }, 'No matches found', false)
    expect(out).toContain('CodeIndex')
    expect(out).toContain('No matches found')
  })

  it('returns the output untouched when there is no hint', () => {
    expect(withCodeIndexNudge('Grep', { pattern: 'def foo' }, 'a.py:1: def foo', false)).toBe('a.py:1: def foo')
  })
})
