import { describe, expect, it } from 'bun:test'
import { editTool, nearMissWindow } from '../../tools/impl/edit.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Finding (g), measured on the L3-3.3 run (session-1785113240581).
 *
 * The model emitted 344 Read calls and 8 Edit calls. Two of the Edits failed,
 * and both were near-misses against real spans of gilded/docket.py: it wrote
 * `_exec_share_trade(ctx, seller, buyer, ent, pct)` where the file says
 * `_exec_share_trade(ctx, seller, buyer, ent, pct, "buy")` — the `"buy"`
 * argument it had itself added an edit earlier. Whole-string similarity 0.672.
 *
 * The engine holds `content` and the normalized old_string at that moment and
 * discards both, returning "Re-read the file to get the exact text." The model
 * did exactly that, forever. The error message is the read attractor.
 *
 * These tests pin that a failed Edit reports what the file ACTUALLY says at the
 * location the model was aiming at, rather than dispatching it back to Read.
 */

const TMP = join(tmpdir(), 'localcode-test-editnearmiss-' + Date.now())

/** The measured shape: the true file. */
const FILE = [
  'def _init_buy_shares(ctx, eid=None, seller_id=None, pct=0.0, **kw):',
  '    ent = next((e for e in ctx.game.enterprises if e.eid == eid), None)',
  '    if ent is None:',
  '        return ["There is no such enterprise"]',
  '    buyer = ctx.executor',
  '    pct = pct * ctx.scale',
  '    return _exec_share_trade(ctx, seller, buyer, ent, pct, "buy")',
  '',
  '',
  'def _init_sell_shares(ctx, eid=None, buyer_id=None, pct=0.0, **kw):',
  '    ent = next((e for e in ctx.game.enterprises if e.eid == eid), None)',
  '    if ent is None:',
  '        return ["There is no such enterprise to sell from"]',
  '',
].join('\n')

/**
 * The measured old_string: right about most lines, wrong about one, and
 * carrying a long line the file has never contained.
 */
const OLD = [
  '    pct = pct * ctx.scale',
  '    return _exec_share_trade(ctx, seller, buyer, ent, pct)',
  '',
  '',
  'def _init_sell_shares(ctx, eid=None, buyer_id=None, pct=0.0, **kw):',
  '    msgs.append(f"buys {re.match(r\'.*buys ([0-9.]+)% of (.+) from (.+)$\', result[0]).group(1)} percent")',
].join('\n')

describe('Edit near-miss reporting', () => {
  it('quotes the line the model got wrong, with its line number', () => {
    const report = nearMissWindow(FILE, OLD)
    expect(report).not.toBeNull()
    // The whole point: the model is shown the `, "buy"` it dropped.
    expect(report).toContain('_exec_share_trade(ctx, seller, buyer, ent, pct, "buy")')
    expect(report).toContain('7\t')
  })

  it('does not pick the longest line as the anchor', () => {
    // The trap this fix has to survive. The longest line of the measured
    // old_string was a regex the model invented; anchoring on length alone
    // finds nothing and reports nothing. The anchor must be the longest line
    // that occurs EXACTLY ONCE in the file.
    const longest = OLD.split('\n').reduce((a, b) => (b.trim().length > a.trim().length ? b : a))
    expect(longest).toContain('re.match')
    expect(FILE).not.toContain('re.match')
    expect(nearMissWindow(FILE, OLD)).not.toBeNull()
  })

  it('skips a longer line that occurs more than once', () => {
    // Uniqueness is the other half of the anchor rule, and the fixture above
    // cannot see it: there the invented line occurs zero times, so requiring
    // exactly one hit and requiring at least one behave identically. A line
    // that occurs TWICE is the case that separates them — anchoring on it
    // quotes an arbitrary copy, which is the confidently-wrong answer this
    // whole fix exists to avoid.
    const dup = [
      'def target_function():',
      '    value = compute(a, b, c, d, e, f, g)',
      '    return value',
      '',
      'def decoy_function():',
      '    value = compute(a, b, c, d, e, f, g)',
      '    return value',
      '',
    ].join('\n')
    const old = [
      'def target_function():',
      '    value = compute(a, b, c, d, e, f, g)',
      '    return nothing_like_this',
    ].join('\n')
    const report = nearMissWindow(dup, old)!
    expect(report).toContain('def target_function')
    expect(report).not.toContain('def decoy_function')
  })

  it('aligns the window to where old_string starts, not to the anchor', () => {
    // The unique anchor here is the `def _init_sell_shares` line, which sits
    // 4 lines into old_string. A window starting at the anchor would show the
    // model only text it already had right and would hide the one line it got
    // wrong — the failure would repeat verbatim.
    const report = nearMissWindow(FILE, OLD)!
    expect(report.split('\n')[0]).toContain('6\t')
    expect(report).toContain('def _init_sell_shares')
  })

  it('reports nothing rather than guessing when no line matches', () => {
    // Honest absence. If not one line of old_string occurs uniquely in the
    // file, the location genuinely is not known and nothing may be invented.
    expect(nearMissWindow(FILE, 'wholly\nunrelated\ntext\n')).toBeNull()
  })

  it('the failing Edit tells the model what the file says instead of to re-read', async () => {
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'docket.py')
    writeFileSync(path, FILE)
    const result = await editTool.execute(
      { file_path: path, old_string: OLD, new_string: 'irrelevant' },
      TMP,
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('_exec_share_trade(ctx, seller, buyer, ent, pct, "buy")')
    // The read attractor itself. 344 Reads followed from this sentence, so the
    // instruction must be gone and its negation must be present — a bare
    // substring check on 're-read the file' would pass on 'Do NOT re-read'.
    expect(result.output).not.toContain('Re-read the file to get the exact text')
    expect(result.output).toContain('Do NOT re-read the file')
    rmSync(TMP, { recursive: true, force: true })
  })

  it('keeps the generic message when the location cannot be identified', async () => {
    // Guard, not a gate: it passes at HEAD. It exists so the fix cannot become
    // an excuse to always emit a confident-looking window — when nothing
    // matches, re-reading really is the right advice.
    mkdirSync(TMP, { recursive: true })
    const path = join(TMP, 'other.py')
    writeFileSync(path, FILE)
    const result = await editTool.execute(
      { file_path: path, old_string: 'nothing here matches', new_string: 'x' },
      TMP,
    )
    expect(result.isError).toBe(true)
    expect(result.output.toLowerCase()).toContain('re-read the file')
    rmSync(TMP, { recursive: true, force: true })
  })
})
