// One Windows command line from an executable and its arguments (F217).
//
// `windowsCommandLine` builds what `Win32_Process.Create` runs when an app's
// model server is started again. It escaped a double quote and not the
// backslashes before it, so an argument ending in a backslash, or holding a
// backslash before a quote, came out as a different argument, or ran into the
// next one. The rules are the ones the Windows C runtime parses with:
// backslashes are literal unless they come before a double quote; 2n of them
// before a quote are n backslashes and the quote ends the argument; 2n+1 are n
// backslashes and a literal quote.
import { describe, expect, it } from 'vitest'
import { windowsCommandLine } from '../../apps/displace.js'

/** How the Windows C runtime splits a command line (the rules above), to read back what was written. */
function parse(line: string): string[] {
  const out: string[] = []
  let cur = '', quoted = false, any = false, i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') {
      let n = 0
      while (line[i] === '\\') { n++; i++ }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) { cur += '"'; i++ }
      } else cur += '\\'.repeat(n)
      any = true
      continue
    }
    if (ch === '"') { quoted = !quoted; any = true; i++; continue }
    if (!quoted && /\s/.test(ch)) { if (any) out.push(cur); cur = ''; any = false; i++; continue }
    cur += ch; any = true; i++
  }
  if (any) out.push(cur)
  return out
}

const roundTrip = (exe: string, args: string[]) => parse(windowsCommandLine(exe, args))

describe('windowsCommandLine', () => {
  it('a plain launcher: the executable is quoted, simple arguments are not', () => {
    expect(windowsCommandLine('C:\\Program Files\\Git\\usr\\bin\\bash.exe', ['scripts/start-llm.sh']))
      .toBe('"C:\\Program Files\\Git\\usr\\bin\\bash.exe" scripts/start-llm.sh')
    expect(windowsCommandLine('C:\\Windows\\System32\\cmd.exe', ['/c', 'scripts\\start-llm.cmd']))
      .toBe('"C:\\Windows\\System32\\cmd.exe" /c scripts\\start-llm.cmd')
  })

  it('an argument with a space that ends in a backslash stays one argument (the backslash used to swallow the closing quote)', () => {
    const args = ['C:\\My Games\\dnd ai\\', 'next']
    expect(roundTrip('x.exe', args)).toEqual(['x.exe', ...args])
    expect(windowsCommandLine('x.exe', args)).toBe('"x.exe" "C:\\My Games\\dnd ai\\\\" next')
  })

  it('a backslash before a quote, a quote alone, and a run of backslashes come back as written', () => {
    for (const arg of ['say "hi"', 'a\\"b c', 'tail\\\\', 'mid\\\\dle part', '\\\\server\\share\\my file.cmd', 'x\\\\\\"y z']) {
      expect(roundTrip('x.exe', [arg, 'after']), arg).toEqual(['x.exe', arg, 'after'])
    }
  })

  it('an empty argument is kept as an argument', () => {
    expect(roundTrip('x.exe', ['', 'b'])).toEqual(['x.exe', '', 'b'])
  })

  it('an executable path that ends in a backslash does not swallow the first argument', () => {
    expect(roundTrip('C:\\tools dir\\', ['a'])).toEqual(['C:\\tools dir\\', 'a'])
  })
})
