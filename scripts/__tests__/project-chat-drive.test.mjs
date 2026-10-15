import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArgs, resultText, inputSummary, typeCounts, promptedImages, askAnswer, answersOpen,
  commandRefusal, refusalLine, picturesNote, picturesEvidence, everyPictureEvidence, didNotRunEvidence, mergePicture, turnEvidence,
  frameThrottle, frameBrief, usageText, isStuckHalt, RESULT_CAP,
  chatStampMs, chatIngestNotOurs, pickChat, chatFromApi, noChatIngestWhy, CHAT_WAIT_MS,
} from '../project-chat-drive.mjs'

const DRIVER = fileURLToPath(new URL('../project-chat-drive.mjs', import.meta.url))

describe('project-chat-drive: parseArgs', () => {
  it('reads every flag and strips the base URL\'s trailing slash', () => {
    const o = parseArgs(['--slug', 'front-yard-2', '--chat', '2026-10-12-a_b.c.jsonl', '--message', 'paint three takes', '--base', 'http://127.0.0.1:19161/', '--timeout-min', '5', '--project-dir', 'P', '--summary', 'S.json', '--hold-min', '2'])
    expect(o).toEqual({ slug: 'front-yard-2', chat: '2026-10-12-a_b.c.jsonl', fresh: false, message: 'paint three takes', base: 'http://127.0.0.1:19161', timeoutMin: 5, projectDir: 'P', summary: 'S.json', holdMin: 2, help: false })
  })
  it('defaults to the diorama project, a 15-minute deadline and no hold', () => {
    const o = parseArgs(['--new', '--message', 'x'])
    expect(o.slug).toBe('front-yard-diorama')
    expect(o.fresh).toBe(true)
    expect(o.chat).toBeNull()
    expect(o.timeoutMin).toBe(15)
    expect(o.holdMin).toBe(0)
    expect(parseArgs(['--help']).help).toBe(true)
  })
  it('reads --message-file trimmed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcd-'))
    const f = join(dir, 'm.txt')
    writeFileSync(f, '\n  draw the yard  \n')
    expect(parseArgs(['--message-file', f]).message).toBe('draw the yard')
  })
  it('refuses a --chat that is a path, not a bare transcript file name, before connecting', () => {
    for (const chat of ['chats/2026-10-12-x.jsonl', 'C:\\p\\chats\\x.jsonl', '../x.jsonl', 'a..b.jsonl', 'x.json', 'x y.jsonl', '']) {
      expect(() => parseArgs(['--chat', chat, '--message', 'm']), chat).toThrow(/--chat .* is not a transcript file name/)
    }
  })
  it('refuses a slug the socket would refuse', () => {
    for (const slug of ['Front-Yard', 'front yard', 'front_yard', '', 'a'.repeat(65)]) {
      expect(() => parseArgs(['--slug', slug, '--message', 'm']), slug).toThrow(/--slug .* is not a project slug/)
    }
    expect(parseArgs(['--slug', 'a'.repeat(64)]).slug).toHaveLength(64)
  })
  it('refuses --chat with --new, an unknown flag, a flag with no value and a bad number', () => {
    expect(() => parseArgs(['--chat', 'x.jsonl', '--new'])).toThrow(/--chat and --new exclude each other/)
    expect(() => parseArgs(['--new', '--chat', 'x.jsonl'])).toThrow(/exclude each other/)
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument: --frobnicate/)
    expect(() => parseArgs(['--message'])).toThrow(/--message needs a value/)
    expect(() => parseArgs(['--timeout-min', '0'])).toThrow(/--timeout-min/)
    expect(() => parseArgs(['--hold-min', 'soon'])).toThrow(/--hold-min/)
  })
  it('refuses a minutes value a timer cannot hold: not finite, or past 2^31-1 ms (setTimeout would fire at once)', () => {
    for (const flag of ['--timeout-min', '--hold-min']) {
      for (const bad of ['Infinity', '1e9', '35791.4', '-1']) {
        expect(() => parseArgs([flag, bad]), `${flag} ${bad}`).toThrow(new RegExp(flag))
      }
    }
    // 35791 min = 2,147,460,000 ms, just under 2^31-1.
    expect(parseArgs(['--timeout-min', '35791']).timeoutMin).toBe(35791)
    expect(parseArgs(['--hold-min', '35791']).holdMin).toBe(35791)
    expect(parseArgs(['--hold-min', '0']).holdMin).toBe(0)
    expect(parseArgs(['--hold-min', '0.01']).holdMin).toBe(0.01)
  })
})

describe('project-chat-drive: resultText', () => {
  it('reads a string, content blocks, a { text } object and anything else as JSON', () => {
    expect(resultText('plain')).toBe('plain')
    expect(resultText([{ type: 'text', text: 'a' }, 'b', { type: 'image' }])).toBe('a\nb\n{"type":"image"}')
    expect(resultText({ text: 'inner' })).toBe('inner')
    expect(resultText({ ok: true })).toBe('{"ok":true}')
    expect(resultText(undefined)).toBe('')
    expect(resultText(null)).toBe('null')
  })
})

describe('project-chat-drive: inputSummary', () => {
  it('shows a Bash command folded and cut at 160 characters', () => {
    expect(inputSummary('Bash', { command: 'curl  -s\n http://127.0.0.1:8188/prompt' })).toBe('command: curl -s http://127.0.0.1:8188/prompt')
    expect(inputSummary('Bash', { command: 'x'.repeat(300) })).toBe(`command: ${'x'.repeat(160)}`)
  })
  it('counts RenderUI elements under spec and when the spec is the input itself', () => {
    expect(inputSummary('RenderUI', { surface: 'designs', spec: { root: 'g', elements: { g: {}, c1: {}, i1: {} } } })).toBe('surface=designs elements=3')
    expect(inputSummary('RenderUI', { root: 'g', elements: { g: {}, c1: {} } })).toBe('surface=(none) elements=2')
    expect(inputSummary('RenderUI', { surface: 's', root: 'g', elements: { g: {} } })).toBe('surface=s elements=1')
    expect(inputSummary('RenderUI', { spec: null })).toBe('surface=(none) elements=0')
    expect(inputSummary('RenderUI', undefined)).toBe('surface=(none) elements=0')
  })
  it('names the path a Read is about, else the input as JSON', () => {
    expect(inputSummary('Read', { file_path: 'C:/p/notes.md', limit: 5 })).toBe('file_path: C:/p/notes.md')
    expect(inputSummary('Grep', { pattern: 'Pictures' })).toBe('pattern: Pictures')
    expect(inputSummary('Other', { n: 1 })).toBe('{"n":1}')
  })
})

describe('project-chat-drive: typeCounts', () => {
  it('counts element types in order of first appearance', () => {
    expect(typeCounts({ elements: { g: { type: 'Grid' }, c1: { type: 'Card' }, i1: { type: 'Image' }, c2: { type: 'Card' }, x: {} } })).toBe('Grid×1 Card×2 Image×1 ?×1')
  })
  it('says (empty) for no elements or no spec', () => {
    expect(typeCounts({ elements: {} })).toBe('(empty)')
    expect(typeCounts(null)).toBe('(empty)')
  })
})

describe('project-chat-drive: promptedImages', () => {
  const spec = {
    elements: {
      g: { type: 'Grid' },
      a: { type: 'Image', props: { prompt: 'a red door', seed: 7 }, image: { status: 'queued', key: 'k'.repeat(64) } },
      b: { type: 'Image', props: { prompt: 'a blue door', seed: 1.5 }, image: { status: 'failed', key: 'f'.repeat(64), reason: 'ComfyUI is not running' } },
      c: { type: 'Image', props: { prompt: 'a green door', seed: '9' } },
      d: { type: 'Image', props: { src: 'images/x.png' } },
    },
  }
  it('keeps an integer seed and nulls any other, and carries the picture state', () => {
    const out = promptedImages(spec)
    expect(out.map(i => i.elementId)).toEqual(['a', 'b', 'c'])
    expect(out[0]).toEqual({ elementId: 'a', promptLen: 10, prompt: 'a red door', seed: 7, status: 'queued', key: 'k'.repeat(64), reason: null })
    expect(out[1]).toMatchObject({ seed: null, status: 'failed', key: 'f'.repeat(64), reason: 'ComfyUI is not running' })
    expect(out[2]).toMatchObject({ seed: null, status: '(no state)', key: null, reason: null })
  })
  it('finds nothing in a spec with no elements', () => {
    expect(promptedImages({})).toEqual([])
    expect(promptedImages(null)).toEqual([])
    expect(promptedImages({ elements: {} })).toEqual([])
  })
})

describe('project-chat-drive: askAnswer', () => {
  it('picks the first yes-like option, else the first option, else a yes', () => {
    expect(askAnswer({ options: ['No, stop', 'Yes, all three'] })).toBe('Yes, all three')
    expect(askAnswer({ options: ['Proceed with 6 takes', 'Cancel'] })).toBe('Proceed with 6 takes')
    expect(askAnswer({ options: ['Option A', 'Option B'] })).toBe('Option A')
    expect(askAnswer({ options: [42, 'Only'] })).toBe('Only')
    expect(askAnswer({})).toMatch(/^Yes, go ahead/)
  })
})

describe('project-chat-drive: answersOpen', () => {
  it('matches the slug, and the chat we asked for or none', () => {
    expect(answersOpen({ slug: 'p', chat: 'x.jsonl' }, { slug: 'p', chat: 'x.jsonl' })).toBe(true)
    expect(answersOpen({ slug: 'p', chat: 'y.jsonl' }, { slug: 'p', chat: 'x.jsonl' })).toBe(false)
    expect(answersOpen({ slug: 'q', chat: null }, { slug: 'p', chat: null })).toBe(false)
    expect(answersOpen({ slug: 'p', chat: null }, { slug: 'p', chat: null })).toBe(true)
    expect(answersOpen({ slug: 'p' }, { slug: 'p', chat: null })).toBe(true)
    expect(answersOpen({ slug: 'p', chat: 'old.jsonl' }, { slug: 'p', chat: null })).toBe(false)
  })
})

describe('project-chat-drive: commandRefusal', () => {
  it('names the refused frame type from the socket\'s refusal text', () => {
    expect(commandRefusal('command frame refused: project.open: chat must be a transcript file name')).toEqual({ frame: 'project.open', reason: 'project.open: chat must be a transcript file name' })
    expect(commandRefusal('command frame refused: user.message: text must be a string')).toMatchObject({ frame: 'user.message' })
    expect(commandRefusal('command frame refused: frame type "user.message" is not allowed from the dashboard')).toMatchObject({ frame: 'user.message' })
    expect(commandRefusal('command frame refused: frame is not valid JSON')).toEqual({ frame: null, reason: 'frame is not valid JSON' })
  })
  it('is null for any other error', () => {
    expect(commandRefusal('project.open refused: no such project')).toBeNull()
    expect(commandRefusal('stream cut: socket hang up')).toBeNull()
    expect(commandRefusal(undefined)).toBeNull()
  })
})

describe('project-chat-drive: refusalLine', () => {
  it('names the frame when the refusal names one, and says "a command frame" when it does not', () => {
    expect(refusalLine(commandRefusal('command frame refused: user.message: text must be a string'))).toBe('the engine refused our user.message frame — user.message: text must be a string')
    expect(refusalLine(commandRefusal('command frame refused: ask.answer: answer must be a string'))).toBe('the engine refused our ask.answer frame — ask.answer: answer must be a string')
    const anon = refusalLine(commandRefusal('command frame refused: frame is not valid JSON'))
    expect(anon).toBe('the engine refused a command frame — frame is not valid JSON')
    expect(anon).not.toMatch(/user\.message/)
  })
})

const NOTE = 'Pictures: 3 generating — they appear in their cards by themselves; do not call RenderUI again for them.'
// The engine's other two spellings (engine/imagegen/service.ts annotateInner): some made before, or all of them.
const MIX = 'Pictures: 8 generating, 4 already made — they appear in their cards by themselves; do not call RenderUI again for them.'
const MADE = 'Pictures: 12 already made — shown in their cards.'

describe('project-chat-drive: picturesNote', () => {
  it('finds the note at a line start or after a Files note on the same line', () => {
    expect(picturesNote(`Drew 4 elements. (surface: s)\n${NOTE}`)).toBe(NOTE)
    expect(picturesNote(`Drew 4. (surface: s)\nFiles: not in the project — a.png; write the file first. ${NOTE}`)).toBe(NOTE)
    expect(picturesNote('Drew 4 elements.')).toBeNull()
  })
  it('finds the "already made" spellings too', () => {
    expect(picturesNote(`Drew 4. (surface: s)\n${MADE}`)).toBe(MADE)
    expect(picturesNote(`Drew 4. (surface: s)\n${MIX}`)).toBe(MIX)
  })
})

describe('project-chat-drive: picturesEvidence', () => {
  const render = (text, toolId = 't1') => ({ toolId, name: 'RenderUI', text })
  const frame = (toolId, statuses) => ({ toolId, final: { types: 'Image×' + statuses.length, images: statuses.map(status => ({ status })) } })
  it('passes on the note anywhere in a RenderUI result, a joined Files note included', () => {
    const r = picturesEvidence([render(`Drew 4. (surface: s)\nFiles: not shown — x. ${NOTE}`)], [])
    expect(r.ok).toBe(true)
    expect(r.evidence).toBe(NOTE)
  })
  it('falls back to the call\'s own final frame when the engine cut the result before the note', () => {
    const cut = 'Drew 12 elements.\nNotes:\n' + '- a validator note that runs long\n'.repeat(20)
    const text = cut.slice(0, RESULT_CAP)
    expect(text).toHaveLength(RESULT_CAP)
    const r = picturesEvidence([render(text, 't1')], [frame('t0', ['queued', 'queued', 'queued', 'queued']), frame('t1', ['queued', 'running', 'done', 'failed'])])
    expect(r).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 2 queued or running, 1 already made' })
  })
  it('uses every final frame when the cut call has none of its own, and fails on nothing queued, running or done', () => {
    const text = 'x'.repeat(RESULT_CAP)
    expect(picturesEvidence([render(text, 'tX')], [frame('t0', ['queued'])])).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 1 queued or running' })
    expect(picturesEvidence([render(text, 'tX')], [frame('t0', ['running'])])).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 1 queued or running' })
    expect(picturesEvidence([render(text, 't1')], [frame('t1', ['failed', 'off'])])).toEqual({ ok: false, evidence: 'result truncated by the engine; the final frame shows 0 queued or running, 0 already made' })
  })
  it('counts done Images in the cut call\'s frame as already made: a frame of done pictures passes', () => {
    const text = 'x'.repeat(RESULT_CAP)
    expect(picturesEvidence([render(text, 't1')], [frame('t1', ['done', 'done', 'failed'])])).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 2 already made (nothing painted this run)' })
    expect(picturesEvidence([render(text, 'tX')], [frame('t0', ['done'])])).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 1 already made (nothing painted this run)' })
  })
  it('passes on "Pictures: N already made": the same prompts and seeds again paint nothing, and that is correct', () => {
    expect(picturesEvidence([render(`Drew 13 elements. (surface: s)\n${MADE}`)], [])).toEqual({ ok: true, evidence: 'Pictures: 12 already made (nothing painted this run)' })
    // Joined to a Files note on one line, and with the repeat note after it.
    expect(picturesEvidence([render('Drew 4. (surface: s)\nFiles: not shown — x. Pictures: 2 already made — shown in their cards. 2 Images repeat the prompt and seed of another — give each take its own "seed" for another picture.')], [])).toEqual({ ok: true, evidence: 'Pictures: 2 already made (nothing painted this run)' })
  })
  it('passes on a mix, and its evidence names both counts', () => {
    const r = picturesEvidence([render(`Drew 13 elements. (surface: s)\n${MIX}`)], [])
    expect(r).toEqual({ ok: true, evidence: MIX })
    expect(r.evidence).toMatch(/^Pictures: 8 generating, 4 already made — /)
  })
  it('prefers a call that is painting over one whose pictures were all made', () => {
    expect(picturesEvidence([render(`Drew 2. (surface: a)\n${MADE}`, 't1'), render(`Drew 4. (surface: b)\n${NOTE}`, 't2')], [])).toEqual({ ok: true, evidence: NOTE })
    // A cut call whose frame shows queued pictures is painting too.
    const cut = 'x'.repeat(RESULT_CAP)
    expect(picturesEvidence([render(`Drew 2. (surface: a)\n${MADE}`, 't1'), render(cut, 't2')], [frame('t2', ['queued'])])).toEqual({ ok: true, evidence: 'result truncated by the engine; the final frame shows 1 queued or running' })
    // An "already made" note beats a cut call whose frame shows only done pictures.
    expect(picturesEvidence([render(cut, 't2'), render(`Drew 2. (surface: a)\n${MADE}`, 't1')], [frame('t2', ['done'])])).toEqual({ ok: true, evidence: 'Pictures: 12 already made (nothing painted this run)' })
  })
  it('fails with what the results said when no note and no cut, or no RenderUI at all', () => {
    expect(picturesEvidence([render('Drew 4 elements. (surface: s)\nmore'), render('Pictures: not generated — off.')], [frame('t1', ['queued'])])).toEqual({ ok: false, evidence: 'Drew 4 elements. (surface: s) | Pictures: not generated — off.' })
    expect(picturesEvidence([{ toolId: 'b', name: 'Bash', text: NOTE }], [])).toEqual({ ok: false, evidence: 'no RenderUI result' })
  })
})

describe('project-chat-drive: didNotRunEvidence', () => {
  it('sees a withdrawn surface\'s reason, a tool result and a session.error, in either wording', () => {
    const hits = didNotRunEvidence({
      surfaces: [{ final: { types: '(withdrawn)', images: [] }, errors: ['the call did not run'] }, { final: { types: 'Card×1', images: [] }, errors: [] }],
      tools: [{ name: 'RenderUI', text: 'Tool call "RenderUI" was not executed: context critical' }, { name: 'Read', text: 'ok' }],
      errors: ['batch did not run: aborted', 'stream cut'],
    })
    expect(hits).toEqual(['the call did not run', 'Tool call "RenderUI" was not executed: context critical', 'batch did not run: aborted'])
  })
  it('is empty for a clean turn and for no input', () => {
    expect(didNotRunEvidence({ surfaces: [{ errors: [] }], tools: [{ text: 'Drew 4.' }], errors: [] })).toEqual([])
    expect(didNotRunEvidence()).toEqual([])
  })
  it('in a tool result matches only the engine\'s own answer: a result that STARTS "Tool call "<its name>" was not executed: "', () => {
    // A Read/Grep/Bash result quoting a file that holds those words is the tool working.
    const quoting = [
      { name: 'Read', text: '1\t// the batch did not run, so the surface was withdrawn as "the call did not run"' },
      { name: 'Grep', text: 'engine/bridge/conversationLoop.ts:1025: const text = `Tool call "${toolName}" was not executed: ${reason}`' },
      { name: 'Bash', text: 'log: Tool call "RenderUI" was not executed: context critical' },
      { name: 'Read', text: 'Tool call "RenderUI" was not executed: quoted from a note' },
    ]
    expect(didNotRunEvidence({ tools: quoting })).toEqual([])
    // dropToolBatch and the malformed-JSON answer (conversationLoop.ts) — under the call's own name.
    const dropped = 'Tool call "Read" was not executed: context critical'
    const malformed = 'Tool call "RenderUI" was not executed: its arguments were not valid JSON. Parse error: x'
    expect(didNotRunEvidence({ tools: [{ name: 'Read', text: dropped }, { name: 'RenderUI', text: malformed }, { text: 'Tool call "Glob" was not executed: context critical' }] })).toEqual([dropped, malformed, 'Tool call "Glob" was not executed: context critical'])
  })
  it('still scans a surface\'s errors and a session.error\'s text anywhere', () => {
    expect(didNotRunEvidence({ surfaces: [{ errors: ['withdrawn: the call did not run'] }], errors: ['engine: batch was not executed'] })).toEqual(['withdrawn: the call did not run', 'engine: batch was not executed'])
  })
})

describe('project-chat-drive: mergePicture', () => {
  const im = (status, extra = {}) => ({ key: 'k'.repeat(64), status, reason: null, seed: 3, promptLen: 10, prompt: 'a red door', ...extra })
  it('stores a new picture as the frame shows it', () => {
    const { picture, requeued } = mergePicture(undefined, im('queued'), 's/a', 1000)
    expect(requeued).toBeNull()
    expect(picture).toMatchObject({ status: 'queued', reason: null, elementIds: ['s/a'], seed: 3, promptLen: 10, seenAt: 1000, runningAt: null, doneAt: null, requeues: 0, earlier: [] })
  })
  it('re-requests a picture stored as failed that a later frame shows queued: status overwritten, reason and times cleared', () => {
    const failed = { ...mergePicture(undefined, im('queued'), 's/a', 1000).picture, status: 'failed', reason: 'ComfyUI is not running', runningAt: 1500, doneAt: 2000 }
    const { picture, requeued } = mergePicture(failed, im('queued'), 's2/a', 3000)
    expect(requeued).toEqual({ status: 'failed', reason: 'ComfyUI is not running' })
    expect(picture).toMatchObject({ status: 'queued', reason: null, runningAt: null, doneAt: null, requeues: 1, elementIds: ['s/a', 's2/a'], seenAt: 1000 })
    expect(picture.earlier).toEqual([{ status: 'failed', reason: 'ComfyUI is not running' }])
    expect(failed.status).toBe('failed') // the stored one is not mutated
    expect(mergePicture(failed, im('running'), 's/a').picture).toMatchObject({ status: 'running', requeues: 1 })
  })
  it('upgrades to done on a done frame and leaves a pending picture pending', () => {
    const queued = mergePicture(undefined, im('queued'), 's/a').picture
    expect(mergePicture(queued, im('done'), 's/a')).toMatchObject({ picture: { status: 'done', elementIds: ['s/a'], alreadyMade: false }, requeued: null })
    expect(mergePicture(queued, im('queued'), 's/b')).toMatchObject({ picture: { status: 'queued', elementIds: ['s/a', 's/b'] }, requeued: null })
    expect(mergePicture(queued, im('failed'), 's/a').picture.status).toBe('queued')
  })
  it('marks a picture first seen done as already made, and a re-request of it as painted this run', () => {
    expect(mergePicture(undefined, im('queued'), 's/a').picture.alreadyMade).toBe(false)
    const made = mergePicture(undefined, im('done'), 's/a', 1000).picture
    expect(made).toMatchObject({ status: 'done', alreadyMade: true, runningAt: null, doneAt: null })
    expect(mergePicture(made, im('done'), 's/b').picture).toMatchObject({ status: 'done', alreadyMade: true, elementIds: ['s/a', 's/b'] })
    expect(mergePicture(made, im('queued'), 's/b')).toMatchObject({ picture: { status: 'queued', alreadyMade: false, requeues: 1 }, requeued: { status: 'done', reason: null } })
  })
})

describe('project-chat-drive: everyPictureEvidence', () => {
  const pic = (c, status, extra = {}) => ({ key: c.repeat(32), status, reason: null, requeues: 0, alreadyMade: false, ...extra })
  it('passes every picture done, painted this run', () => {
    expect(everyPictureEvidence([pic('a', 'done'), pic('b', 'done')], [])).toEqual({ ok: true, evidence: '2 picture(s): 2 done, 0 failed, 0 pending; 0 not generated' })
  })
  it('passes every picture done at the frame (already made: no ui.image follows) and says nothing was painted', () => {
    expect(everyPictureEvidence([pic('a', 'done', { alreadyMade: true }), pic('b', 'done', { alreadyMade: true })], [])).toEqual({ ok: true, evidence: '2 picture(s): 2 done, 0 failed, 0 pending; 0 not generated; 2 already made at the frame (nothing painted this run)' })
  })
  it('passes a mix, counting the ones already made', () => {
    expect(everyPictureEvidence([pic('a', 'done', { alreadyMade: true }), pic('b', 'done'), pic('c', 'done', { requeues: 1 })], [])).toEqual({ ok: true, evidence: '3 picture(s): 3 done, 0 failed, 0 pending; 0 not generated; 1 already made at the frame; 1 re-requested after settling' })
  })
  it('fails a failed or pending picture, one not generated, and no picture at all', () => {
    const r = everyPictureEvidence([pic('a', 'done', { alreadyMade: true }), pic('b', 'failed', { reason: 'ComfyUI is not running' }), pic('c', 'queued')], [])
    expect(r).toEqual({ ok: false, evidence: '3 picture(s): 1 done, 1 failed, 1 pending; 0 not generated; 1 already made at the frame — bbbbbbbb failed (ComfyUI is not running), cccccccc queued' })
    expect(everyPictureEvidence([pic('a', 'done')], [{ elementId: 'i2', status: 'off', reason: 'unset' }])).toEqual({ ok: false, evidence: '1 picture(s): 1 done, 0 failed, 0 pending; 1 not generated — i2 off (unset)' })
    expect(everyPictureEvidence([], [])).toEqual({ ok: false, evidence: '0 picture(s): 0 done, 0 failed, 0 pending; 0 not generated' })
  })
})

describe('project-chat-drive: turnEvidence', () => {
  const rel = ms => (ms / 1000).toFixed(1)
  it('passes a message.complete with a model stop, then the session_fidelity frame', () => {
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'end_turn' }, error: null }, rel)).toEqual({ ok: true, evidence: 'stop=end_turn at +8.5s' })
    // The model's other stops (engine/types.ts StopReason) reach message.complete as they are.
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'stop_sequence' }, error: null }, rel).ok).toBe(true)
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'max_tokens' }, error: null }, rel).ok).toBe(true)
  })
  it('fails an aborted turn: session_fidelity with no message.complete and no session.error (a Stop, or a project.open from any tab)', () => {
    const r = turnEvidence({ ended: { at: 9000 }, complete: null, error: null }, rel)
    expect(r.ok).toBe(false)
    expect(r.evidence).toMatch(/^aborted: governance\.session_fidelity at \+9\.0s with no message\.complete and no session\.error/)
  })
  it('fails a halted turn and one stopped at max_iterations', () => {
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'halted' }, error: null }, rel)).toEqual({ ok: false, evidence: 'halted: message.complete stop=halted at +8.5s' })
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'max_iterations' }, error: null }, rel)).toEqual({ ok: false, evidence: 'stopped at max_iterations: message.complete stop=max_iterations at +8.5s' })
  })
  it('fails the stuck-loop halt, whose last message.complete is stop=max_iterations (its end_turn falls through to the iteration-budget exit)', () => {
    const r = turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'max_iterations' }, error: null, stuckHalt: { at: 8400 } }, rel)
    expect(r).toEqual({ ok: false, evidence: 'halted: the stuck-loop halt at +8.4s (message.complete stop=max_iterations)' })
  })
  it('fails a stop reason it does not know, and none', () => {
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: 'cancelled' }, error: null }, rel)).toMatchObject({ ok: false, evidence: expect.stringMatching(/^message\.complete stop=cancelled at \+8\.5s/) })
    expect(turnEvidence({ ended: { at: 9000 }, complete: { at: 8500, stopReason: null }, error: null }, rel)).toMatchObject({ ok: false, evidence: expect.stringMatching(/^message\.complete stop=null/) })
  })
  it('fails with the session.error text when the turn ended in an error (no message.complete)', () => {
    const r = turnEvidence({ ended: { at: 9100 }, complete: null, error: { at: 9000, text: 'stream cut: socket hang up' } }, rel)
    expect(r).toEqual({ ok: false, evidence: 'session.error at +9.0s: stream cut: socket hang up' })
  })
  it('fails when no session_fidelity came', () => {
    expect(turnEvidence({ ended: null, complete: null, error: null }).evidence).toMatch(/^never/)
    expect(turnEvidence({ ended: null, complete: { at: 1000, stopReason: 'end_turn' }, error: null }, rel)).toMatchObject({ ok: false, evidence: expect.stringMatching(/no governance\.session_fidelity followed/) })
  })
})

describe('project-chat-drive: isStuckHalt', () => {
  it('knows the stuck-loop halt\'s own stream.token (conversationLoop.ts, Tier 4) and nothing else', () => {
    expect(isStuckHalt('\n\n---\n**Session halted** — stuck for 15 turns without progress. Send a message to redirect.\n')).toBe(true)
    expect(isStuckHalt('Session halted')).toBe(false)
    expect(isStuckHalt('the session halted after a while')).toBe(false)
    expect(isStuckHalt(undefined)).toBe(false)
  })
})

describe('project-chat-drive: the hold\'s frame lines', () => {
  it('lets one line per type through a second and counts what it held back', () => {
    const t = frameThrottle(1000)
    expect(t('stream.token', 0)).toEqual({ held: 0 })
    expect(t('stream.token', 200)).toBeNull()
    expect(t('stream.token', 900)).toBeNull()
    expect(t('ui.image', 950)).toEqual({ held: 0 })
    expect(t('stream.token', 1000)).toEqual({ held: 2 })
    expect(t('stream.token', 1500)).toBeNull()
  })
  it('drains what it still holds back, once, for a last line before a close', () => {
    const t = frameThrottle(1000)
    t('stream.token', 0); t('stream.token', 10); t('stream.token', 20); t('ui.image', 30)
    expect(t.drain()).toEqual([{ type: 'stream.token', held: 2 }])
    expect(t.drain()).toEqual([])
    expect(t('stream.token', 1100)).toEqual({ held: 0 })
  })
  it('briefs a frame by its identifying fields', () => {
    expect(frameBrief({ type: 'ui.image', key: 'abcdef0123456789', status: 'done' })).toBe('status=done key=abcdef01')
    expect(frameBrief({ type: 'session.error', error: 'engine restarting' })).toBe('error="engine restarting"')
    expect(frameBrief({ type: 'stream.token', text: 'x' })).toBe('')
  })
})

describe('project-chat-drive: usage', () => {
  it('stops at the first line that is not a comment', () => {
    expect(usageText('// a\n//   b\r\n//\nimport x from "y"\n// c')).toBe('a\n  b\n')
  })
  it('the driver\'s help is its header and prints no import line', () => {
    const help = usageText(readFileSync(DRIVER, 'utf8'))
    expect(help).toMatch(/^scripts\/project-chat-drive\.mjs/)
    expect(help).toMatch(/--hold-min/)
    expect(help).not.toMatch(/^import /m)
    expect(help).not.toMatch(/node:fs/)
  })
  it('the help says how a new chat is named: the project.ingest after the turn, else the dashboard API', () => {
    const help = usageText(readFileSync(DRIVER, 'utf8'))
    expect(help).toMatch(/project\.ingest/)
    expect(help).toMatch(/\/api\/projects\/<slug>\/chats/)
  })
})

/**
 * Live run 2 of 2026-10-13 finished at once (every picture already made) and
 * its summary had chatFile null: the `project.ingest` (kind 'chat') that names
 * a new chat comes when the engine indexes the chat after message.complete —
 * fire-and-forget, so after the turn's end — and the driver's verdict had
 * already gone out. These pin the pieces of the fix; the socket tests pin the
 * wiring.
 */
describe('project-chat-drive: naming a new chat', () => {
  // 2026-10-13 18:48:52 UTC: the second live run 3's chat was stamped with.
  const AT = Date.UTC(2026, 9, 13, 18, 48, 52)
  const OURS = '20261013T184852-show-me-the-three-tower-designs.jsonl'
  const sentAt = AT + 700
  const endedAt = AT + 72_000
  const iso = (ms) => new Date(ms).toISOString()

  it('waits 30 s at most for the frame', () => {
    expect(CHAT_WAIT_MS).toBe(30_000)
  })

  it('reads the UTC second a chat file name is stamped with (newChatFile), null for a name without a real stamp', () => {
    expect(chatStampMs(OURS)).toBe(AT)
    expect(chatStampMs('20261013T235959-x.jsonl')).toBe(Date.UTC(2026, 9, 13, 23, 59, 59))
    for (const f of ['chats/' + OURS, 'notes.jsonl', '2026-10-13-x.jsonl', '20261313T184852-x.jsonl', '20261013T254852-x.jsonl', '20261013T184852.jsonl', '', null, undefined]) {
      expect(chatStampMs(f), String(f)).toBeNull()
    }
  })

  describe('chatIngestNotOurs: is this project.ingest our chat?', () => {
    const ev = (filePath, slug = 'front-yard-diorama') => ({ type: 'project.ingest', slug, filePath, kind: 'chat', indexed: true })
    const run = { slug: 'front-yard-diorama', chatFile: null, sentAt, endedAt }
    it('a new chat stamped in the second our message was sent, or later but not after the turn ended, is ours', () => {
      expect(chatIngestNotOurs(ev(`chats/${OURS}`), run)).toBeNull()
      expect(chatIngestNotOurs(ev('chats/20261013T184954-x.jsonl'), run)).toBeNull()
      expect(chatIngestNotOurs(ev('chats/20261013T185100-x.jsonl'), { ...run, endedAt: null })).toBeNull() // the turn still running
      expect(chatIngestNotOurs(ev('chats/no-stamp.jsonl'), run)).toBeNull() // nothing to tell it by
    })
    it('another project\'s, one before our message, one stamped before it or after our turn ended is not', () => {
      expect(chatIngestNotOurs(ev(`chats/${OURS}`, 'front-yard-2'), run)).toBe("another project's (slug=front-yard-2)")
      expect(chatIngestNotOurs(ev(`chats/${OURS}`), { ...run, sentAt: null })).toBe('before our message was sent')
      expect(chatIngestNotOurs(ev('chats/20261013T184851-older.jsonl'), run)).toBe('created 2026-10-13T18:48:51.000Z, before our message')
      expect(chatIngestNotOurs(ev('chats/20261013T185005-later.jsonl'), run)).toBe('created 2026-10-13T18:50:05.000Z, after our turn ended')
    })
    it('once the chat is named, only that chat is ours', () => {
      expect(chatIngestNotOurs(ev(`chats/${OURS}`), { ...run, chatFile: OURS })).toBeNull()
      expect(chatIngestNotOurs(ev('chats/20261013T184900-other.jsonl'), { ...run, chatFile: OURS })).toBe(`this run's chat is ${OURS}`)
    })
  })

  describe('pickChat: the dashboard API fallback\'s rule', () => {
    const chats = [ // newest first, as listChatsApi sends them
      { file: '20261013T185134-another-tab.jsonl', title: 'b', createdAt: iso(endedAt + 30_000), messages: 2 },
      { file: OURS, title: 'Show me the three tower designs', createdAt: iso(sentAt + 12), messages: 4 },
      { file: '20261013T174852-earlier.jsonl', title: 'a', createdAt: iso(AT - 3_600_000), messages: 8 },
    ]
    it('takes the chat created between our message and the turn\'s end', () => {
      expect(pickChat(chats, { sentAt, endedAt })).toEqual({ file: OURS, candidates: 1, total: 3 })
    })
    it('of several in the window the earliest: ours is created the moment our message lands', () => {
      const more = [{ file: '20261013T184929-later.jsonl', createdAt: iso(sentAt + 37_000) }, ...chats]
      expect(pickChat(more, { sentAt, endedAt })).toEqual({ file: OURS, candidates: 2, total: 4 })
    })
    it('with no turn end (the deadline, a closed socket) there is no upper bound; the very millisecond of sending counts', () => {
      expect(pickChat(chats, { sentAt, endedAt: null })).toEqual({ file: OURS, candidates: 2, total: 3 })
      expect(pickChat([{ file: OURS, createdAt: iso(sentAt) }], { sentAt, endedAt })).toEqual({ file: OURS, candidates: 1, total: 1 })
      expect(pickChat([{ file: OURS, createdAt: iso(sentAt - 1) }], { sentAt, endedAt })).toEqual({ file: null, candidates: 0, total: 1 })
    })
    it('none in the window, nothing listed, or entries that are not chats: no file', () => {
      expect(pickChat([chats[0], chats[2]], { sentAt, endedAt })).toEqual({ file: null, candidates: 0, total: 2 })
      expect(pickChat([], { sentAt, endedAt })).toEqual({ file: null, candidates: 0, total: 0 })
      expect(pickChat(null, { sentAt, endedAt })).toEqual({ file: null, candidates: 0, total: 0 })
      const junk = [{ file: OURS, createdAt: 'yesterday' }, { file: 'chats/x.jsonl', createdAt: iso(sentAt + 1) }, { file: '..x.jsonl', createdAt: iso(sentAt + 1) }, { createdAt: iso(sentAt + 1) }, 'x', null]
      expect(pickChat(junk, { sentAt, endedAt })).toEqual({ file: null, candidates: 0, total: 0 })
    })
  })

  /**
   * The engine indexes a chat only when a turn ends on its own: the ingestChat
   * call at the natural end of runModelLoop, after that end's message.complete.
   * A halt (stop=halted), the iteration budget (stop=max_iterations) and the
   * stuck-loop halt (its "Session halted" notice and stop=end_turn, falling
   * through to the iteration-budget exit's stop=max_iterations) end the
   * turn elsewhere, and no project.ingest follows — a wait for one is 30 s
   * spent for nothing.
   */
  describe('noChatIngestWhy: will a project.ingest still name the chat?', () => {
    const ended = { at: endedAt, stopReason: null, error: null }
    const complete = (stopReason) => ({ at: endedAt - 5, stopReason, usage: null })
    const OWN = 'and the engine indexes a chat only when a turn ends on its own'
    it('yes, wait for it: the turn ended on a model stop, with no stuck-loop halt, and the socket is open', () => {
      for (const stop of ['end_turn', 'stop_sequence', 'max_tokens']) {
        expect(noChatIngestWhy({ turnEnded: ended, complete: complete(stop) }), stop).toBeNull()
        expect(noChatIngestWhy({ turnEnded: ended, complete: complete(stop), stuckHalt: null, socketOpen: true }), stop).toBeNull()
      }
    })
    it('no, ask the API at once, naming the stop: halted, max_iterations, the stuck-loop halt, any stop that is not the model\'s', () => {
      expect(noChatIngestWhy({ turnEnded: ended, complete: complete('halted') })).toBe(`the turn ended with stop=halted, ${OWN} (a model stop: end_turn, stop_sequence, max_tokens)`)
      expect(noChatIngestWhy({ turnEnded: ended, complete: complete('max_iterations') })).toBe(`the turn ended with stop=max_iterations, ${OWN} (a model stop: end_turn, stop_sequence, max_tokens)`)
      expect(noChatIngestWhy({ turnEnded: ended, complete: complete(null) })).toBe(`the turn ended with stop=null, ${OWN} (a model stop: end_turn, stop_sequence, max_tokens)`)
      expect(noChatIngestWhy({ turnEnded: ended, complete: complete('max_iterations'), stuckHalt: { at: endedAt - 10 } })).toBe(`the turn ended in the stuck-loop halt (message.complete stop=max_iterations), ${OWN}`)
    })
    it('no: the turn did not end, ended with no message.complete, or the socket is closed', () => {
      expect(noChatIngestWhy({ turnEnded: null, complete: null })).toBe('the turn did not end')
      expect(noChatIngestWhy({ turnEnded: null, complete: complete('end_turn') })).toBe('the turn did not end')
      expect(noChatIngestWhy({ turnEnded: ended, complete: null })).toBe('the turn ended with no message.complete, and the engine indexes a chat only after one')
      expect(noChatIngestWhy({ turnEnded: ended, complete: complete('end_turn'), socketOpen: false })).toBe('the socket is closed')
    })
  })

  describe('chatFromApi', () => {
    const args = { base: 'http://127.0.0.1:9161', slug: 'front-yard-diorama', token: 'tok', sentAt, endedAt }
    const URL_ = 'http://127.0.0.1:9161/api/projects/front-yard-diorama/chats'
    const WINDOW = "created at or after the message was sent (2026-10-13T18:48:52.700Z) and no later than the turn's end (2026-10-13T18:50:04.000Z)"
    const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    it('asks GET /api/projects/<slug>/chats with the dashboard token as a Bearer header, and says which rule named the chat', async () => {
      const calls = []
      const fetchImpl = async (url, init) => { calls.push({ url, auth: init?.headers?.Authorization }); return answer(200, { chats: [{ file: OURS, createdAt: iso(sentAt + 12) }] })() }
      expect(await chatFromApi({ ...args, fetchImpl })).toEqual({ file: OURS, how: `dashboard API: the earliest of 1 chat(s) ${WINDOW}` })
      expect(calls).toEqual([{ url: URL_, auth: 'Bearer tok' }])
      // No turn end: the window has no upper bound and says so.
      expect(await chatFromApi({ ...args, endedAt: null, fetchImpl })).toEqual({ file: OURS, how: 'dashboard API: the earliest of 1 chat(s) created at or after the message was sent (2026-10-13T18:48:52.700Z)' })
    })
    it('says why when no chat fits, the API refuses, answers no list or cannot be reached', async () => {
      expect(await chatFromApi({ ...args, fetchImpl: answer(200, { chats: [] }) })).toEqual({ file: null, why: `the dashboard API lists 0 chat(s), none ${WINDOW}` })
      expect(await chatFromApi({ ...args, fetchImpl: answer(401, { error: 'token required' }) })).toEqual({ file: null, why: `GET ${URL_} answered HTTP 401: {"error":"token required"}` })
      expect(await chatFromApi({ ...args, fetchImpl: answer(200, '<html>') })).toEqual({ file: null, why: `GET ${URL_} answered no chats list: "<html>"` })
      expect(await chatFromApi({ ...args, fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9161') } })).toEqual({ file: null, why: `GET ${URL_} failed: connect ECONNREFUSED 127.0.0.1:9161` })
    })
    it('a request that never answers is cut at its timeout', async () => {
      const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
      const r = await chatFromApi({ ...args, fetchImpl: hang, timeoutMs: 50 })
      expect(r.file).toBeNull()
      expect(r.why).toMatch(new RegExp(`^GET ${URL_} failed: .*timeout`, 'i'))
    })
  })
})
