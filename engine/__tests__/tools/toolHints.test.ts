import { describe, expect, it } from 'vitest'
import { betterToolHint, withToolHint } from '../../tools/toolHints.js'

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
