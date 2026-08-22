import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * `scripts/dispatch-mission.sh` refuses to dispatch when the engine rebound its
 * WebSocket to a different port than the one the driver will dial (F116). That
 * refusal is a `grep` against a log the engine is still writing, so it is only
 * as good as its position in the script.
 *
 * F122: it was positioned after a wait loop that breaks on the llama health
 * line, which the engine emits BEFORE it binds the bridge. Measured on the
 * Stage 15 dispatch, "Chat template supports native tool calls" is log line 57
 * and "[ws] Port 9160 in use, using 9162 instead" is line 68. The check ran on
 * a log without the line, found nothing, and dispatched into the collision —
 * and `grep -c` on the finished log returns 1, so the pattern was never wrong.
 *
 * `grep -q` returning false covers both "did not happen" and "has not happened
 * yet", and a clean dispatch looks the same either way. So the ordering is the
 * whole guarantee, and it is asserted here against the source: the wait for the
 * bind must come before the question about the bind.
 *
 * The collision cannot be reproduced in this suite — it needs a real engine
 * process, an orphaned socket, and several minutes of model load. What is
 * checkable is the property that made the guard useless, which is textual.
 */

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', '..', '..', 'scripts', 'dispatch-mission.sh'), 'utf-8')
  .split('\r\n')
  .join('\n')

// Comments explain the bug and quote the patterns, so a scan that read them
// would pass on the very prose recording the fix.
const code = src
  .split('\n')
  .filter(l => !l.trim().startsWith('#'))
  .join('\n')

// The script writes these as grep patterns, so every bracket and dot may or may
// not carry a backslash. Matching the shape rather than the literal keeps this
// guard from failing the next time someone quotes the pattern differently.
const READY = /Ready\\?\. Waiting for TUI connection/
const COLLISION = /Port \\?\[0-9\\?\]\+ in use/

const at = (re: RegExp) => code.search(re)

describe('dispatch-mission.sh asks about the bind only after the bind', () => {
  test('the collision refusal is still present', () => {
    expect(
      at(COLLISION),
      'the F116 refusal is gone: the engine takes the next free port when its own is held, ' +
        'the driver resolves its port independently and would dial the busy one, and the ' +
        'failure surfaces as an S5 refusal that names a real defect which is not the one present',
    ).toBeGreaterThan(-1)
  })

  test('a wait for the WebSocket bind precedes the collision check', () => {
    const waitAt = at(READY)
    const checkAt = at(COLLISION)

    expect(
      waitAt,
      'nothing in the script waits for the bridge to bind. The llama health line the earlier ' +
        'loop breaks on is written before the bind, so the collision check runs against a log ' +
        'that cannot contain the answer yet (F122).',
    ).toBeGreaterThan(-1)

    expect(
      checkAt,
      `the collision check is at offset ${checkAt} and the wait for the bind at ${waitAt}. ` +
        'Asking whether the bind collided before waiting for the bind makes the refusal a race ' +
        'that resolves the wrong way, silently, on every dispatch.',
    ).toBeGreaterThan(waitAt)
  })

  test('failing to bind at all is a refusal, not a shrug', () => {
    const between = code.slice(at(READY), at(COLLISION))

    expect(
      between,
      'the wait for the bind can time out — an engine that never binds its WebSocket is a ' +
        'dispatch that will hang on the driver side instead. Falling through to the collision ' +
        'check restores exactly the race this ordering was introduced to remove.',
    ).toContain('exit 1')
  })

  test('the port is never read back out of the Ready line', () => {
    // The Ready line prints the port the engine was ASKED for, not the one it
    // bound: on the Stage 15 dispatch it said 9160 while listening on 9162. It
    // is a sequencing signal only.
    const readyLines = code.split('\n').filter(l => l.includes('Waiting for TUI connection'))
    for (const line of readyLines) {
      expect(
        line,
        `\`${line.trim()}\` extracts a value from the Ready line. That line names the requested ` +
          'port, not the bound one, so anything derived from it can be the busy port itself.',
      ).not.toMatch(/sed -n|=\$\(|\\\([0-9]/)
    }
  })
})
