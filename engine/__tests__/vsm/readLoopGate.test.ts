import { describe, it, expect } from 'vitest'
import { ReadLoopGate, rearmsGate } from '../../vsm/readLoopGate.js'

describe('ReadLoopGate escalation', () => {
  it('escalates after 3 consecutive denials of the same signature', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    expect(g.evaluate('Read', inp).kind).toBe('allow')   // first read: seen
    expect(g.evaluate('Read', inp).kind).toBe('warn')    // 1st redundant
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 2nd
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 3rd
    const v = g.evaluate('Read', inp)                    // 4th → escalate
    expect(v.kind).toBe('escalate')
    if (v.kind === 'escalate') expect(v.signatures.length).toBeGreaterThan(0)
  })

  it('isDisabled reflects whether a read would be denied', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp) // now in deny mode for this sig
    expect(g.isDisabled('Read', inp)).toBe(true)
    expect(g.isDisabled('Write', { file_path: 'C:/x/a.txt' })).toBe(false)
  })

  it('onWrite resets escalation', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp)
    g.onWrite()
    expect(g.evaluate('Read', { file_path: 'C:/x/b.txt' }).kind).toBe('allow')
  })
})

/**
 * Observed live: CynCo spent iterations 200 through 405 of one task alternating
 * "I MUST EDIT NOW" with a `Read` it was never granted, and wrote in its own
 * reasoning "The system is blocking all reads." It was right. The task never
 * finished.
 *
 * The gate already carries a relent rule for precisely this — a read the model
 * provably cannot proceed without gets served rather than refused, because Edit
 * needs an exact `old_string` and a blinded model cannot produce one. But relenting
 * was counted per-signature, and the stall branch refuses reads the model has
 * NEVER seen. Novel reads have novel signatures by definition, so the counter
 * reset on every call and the escape hatch could not be reached from that branch.
 */
describe('ReadLoopGate stall branch — the escape hatch must be reachable', () => {
  /**
   * A run of reads that are each of a *distinct* region, so every one of them
   * lands on the stall branch. Reusing a path would route the calls to the
   * redundant branch instead, which never arms the stall warning — a fixture that
   * looks like it stresses the stall gate while testing nothing.
   */
  const novelReads = (g: ReadLoopGate, n: number) =>
    Array.from({ length: n }, (_, i) =>
      g.evaluate('Read', { file_path: 'docket.py', offset: i * 10, limit: 10 }).kind,
    )

  it('nags, then gives way — it never refuses novel reads forever', () => {
    const kinds = novelReads(new ReadLoopGate(), 30)

    // Under the cap the gate is silent.
    expect(kinds.slice(0, 19)).toEqual(Array(19).fill('allow'))
    // Then one warning, two refusals, and it yields — the same shape the redundant
    // branch already used, and for the same reason.
    expect(kinds.slice(19, 23)).toEqual(['warn', 'deny', 'deny', 'escalate'])
    // Having yielded it stays yielded. This is the whole point: the model must be
    // able to reach an exact `old_string`, or the order to "make an edit now"
    // cannot be obeyed.
    expect(kinds.slice(23)).toEqual(Array(kinds.length - 23).fill('allow'))
  })

  it('an edit re-arms it, so the nag returns on the next stall', () => {
    const g = new ReadLoopGate()
    novelReads(g, 30)
    g.onWrite('docket.py')
    // onWrite forgot every read of docket.py, so these are novel again.
    expect(novelReads(g, 23).slice(19)).toEqual(['warn', 'deny', 'deny', 'escalate'])
  })
})

describe('rearmsGate — which tool calls count as "the model made a change"', () => {
  it('counts the editor tools', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction']) {
      expect(rearmsGate(t, { file_path: 'a.py' }, false), t).toBe(true)
    }
  })

  it('counts a shell rewrite, which is how a Read-denied model actually edits', () => {
    const cmd = `python -c "content = open('docket.py').read(); open('docket.py','w').write(content.replace(old, new))"`
    expect(rearmsGate('Bash', { command: cmd }, false)).toBe(true)
  })

  it('does not count ordinary shell work', () => {
    expect(rearmsGate('Bash', { command: 'python -m pytest gilded/ -q' }, false)).toBe(false)
    expect(rearmsGate('Bash', { command: 'git status' }, false)).toBe(false)
    expect(rearmsGate('Read', { file_path: 'a.py' }, false)).toBe(false)
  })

  it('does not count a call that failed — nothing changed on disk', () => {
    expect(rearmsGate('Edit', { file_path: 'a.py' }, true)).toBe(false)
  })
})
