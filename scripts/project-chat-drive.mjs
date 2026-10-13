// scripts/project-chat-drive.mjs — drive ONE project-chat turn through the
// dashboard socket exactly as the page does, and log what the engine sends
// back. The regression driver for the picture pipeline (F176 in
// docs/cynco-failure-log.md): no browser, no model stub — the real engine,
// the real model, the real ComfyUI.
//
//   bun scripts/project-chat-drive.mjs --slug front-yard-diorama \
//       [--chat <a file name in the project's chats/, e.g. 2026-10-12-x.jsonl> | --new] \
//       (--message "<text>" | --message-file <file>) \
//       [--base http://127.0.0.1:9161] [--timeout-min 15] \
//       [--project-dir <project folder>] [--summary <file.json>] [--hold-min N]
//
// --slug and --chat are checked against the socket's own rules before it
// connects (engine/bridge/commandSchema.ts): a slug is a-z, 0-9 and -, at most
// 64 characters; a chat is a bare *.jsonl file name — no folder, no "..".
// It connects to ws://<base>/ws?token=<dashboard token from ~/.cynco/tokens.json>,
// sends `project.open { slug, chat }` (no chat: a fresh one), waits for the
// `project.opened` that answers it, sends `user.message { text }`, and logs
// with timestamps:
//   ui.render        partial/final, surface id, element types, prompted Images
//   ui.image         key, status, reason
//   tool.start       name and a one-line input summary
//   tool.complete    name, isError, the result's first line (and its Pictures: note)
//   approval.request answered approved:false and logged as a FAIL mark — a project
//                    chat asking to run a ComfyUI command is itself a failure
//   ask.request      answered with a sensible choice, logged
//   message.complete the stop reason (a turn cut by an error or aborted sends none)
//   session.error    after our message: the turn's error (a stream cut, a
//                    provider error); a refusal of a frame we sent ends the run
//   governance.session_fidelity  the turn's end: the engine sends it exactly
//                    once per user message, on every exit path (F158)
//   After that a frame is another turn's (a click re-dispatched after ours,
//   the operator typing on the page) — its message.complete, session.error,
//   session_fidelity, tool.start, tool.complete and a ui.render for a surface
//   our turn never drew: logged, never counted. Its approval and ask cards are
//   still answered (the engine waits on them), never recorded as ours. A
//   ui.render for one of our own surfaces still counts: the turn's end
//   withdraws a surface left open after session_fidelity.
// It exits when the turn has ended and every picture of the turn's final
// frames is done or failed (or not generated), or at --timeout-min.
// Then it prints PASS/FAIL per criterion (a final frame with seeded prompted
// Images, a result saying the pictures are generating or already made —
// "Pictures: N generating", "Pictures: N already made" when the same prompts
// and seeds were painted before — no Bash call, no approval card, no "did not
// run", the turn ended on its own — a message.complete with a model stop and
// no session.error; an abort, a halt or max_iterations fails — every picture
// done, done at the frame included; with --project-dir also each
// images/<key>.png + .json with seedFrom "model" and the prompt as written)
// and exits 0 when every criterion passed, 1 when one failed, 2 at the
// deadline, 3 when the socket closed first, 4 when the project did not open
// or the engine refused a frame the driver sent.
// --hold-min keeps the socket open after that and logs each frame type the
// engine still sends (one line per type a second at most; an engine restart
// shows as a close) — for the restart test.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DEFAULT_BASE = 'http://127.0.0.1:9161'
const DEFAULT_TIMEOUT_MIN = 15
/** The dashboard server replays its cache and, when the engine holds a project,
 *  a `project.opened` the moment a socket opens; our `project.open` goes out
 *  after that burst so its answer cannot be confused with the stale frame. */
const SETTLE_MS = 750
const OPEN_TIMEOUT_MS = 60_000
const PING_EVERY_MS = 30_000
const HEARTBEAT_MS = 60_000
/** During a hold: at most one line per frame type in this window. */
const HOLD_LINE_EVERY_MS = 1_000
/** The engine cuts a `tool.complete` result to this many characters
 *  (`result.output.slice(0, 500)` in executeOneTool). */
export const RESULT_CAP = 500
/** The socket's rules for `project.open` (engine/bridge/commandSchema.ts). */
export const SLUG_RE = /^[a-z0-9-]{1,64}$/
export const CHAT_RE = /^[A-Za-z0-9._-]+\.jsonl$/
/** Anywhere in the text: the engine can join a "Files: …" note and the
 *  Pictures note on one line (engine/imagegen/service.ts annotate). Its
 *  spellings (annotateInner): "Pictures: N generating", "Pictures: N
 *  generating, M already made", and — a call whose pictures were all made
 *  before, the same prompts and seeds again, which queues nothing and is
 *  correct — "Pictures: M already made — shown in their cards." */
const PICTURES_RE = /\bPictures: (\d+) generating/
const ALREADY_MADE_RE = /\bPictures: (\d+) already made\b/
/** In a surface's errors and a session.error: the withdrawal wording after a
 *  batch (F175) and dropToolBatch's. */
const DID_NOT_RUN_RE = /did not run|was not executed/
/** In a tool result only the engine's own answer counts: dropToolBatch and the
 *  malformed-JSON answer both START `Tool call "<name>" was not executed: `
 *  (engine/bridge/conversationLoop.ts). A Read/Grep/Bash result that quotes a
 *  file holding those words is the tool working. */
const NOT_EXECUTED_RE = /^Tool call "([^"]*)" was not executed: /
/** The stop reasons of a turn that ended on its own: the model's
 *  (engine/types.ts StopReason; a 'tool_use' with no tool blocks becomes
 *  end_turn before message.complete). The loop's own 'halted' (the algedonic
 *  halt) and 'max_iterations' (the budget ran out) are failures. */
export const NORMAL_STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens'])
/** The largest delay a timer holds (2^31-1 ms); setTimeout fires a larger one at once. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** The stuck-loop halt (Tier 4 in runModelLoop) ends the turn with stop=end_turn
 *  and says so only in its own stream.token. */
const STUCK_HALT_RE = /\*\*Session halted\*\* — stuck for \d+ turns/

export function parseArgs(argv) {
  const o = { slug: 'front-yard-diorama', chat: null, fresh: false, message: null, base: DEFAULT_BASE, timeoutMin: DEFAULT_TIMEOUT_MIN, projectDir: null, summary: null, holdMin: 0, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--slug': o.slug = v(); break
      case '--chat': o.chat = v(); break
      case '--new': o.fresh = true; break
      case '--message': o.message = v(); break
      case '--message-file': o.message = readFileSync(v(), 'utf8').trim(); break
      case '--base': o.base = v().replace(/\/+$/, ''); break
      case '--timeout-min': o.timeoutMin = Number(v()); break
      case '--project-dir': o.projectDir = v(); break
      case '--summary': o.summary = v(); break
      case '--hold-min': o.holdMin = Number(v()); break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  if (o.chat !== null && o.fresh) throw new Error('--chat and --new exclude each other')
  if (!SLUG_RE.test(o.slug)) throw new Error(`--slug ${JSON.stringify(o.slug)} is not a project slug: lower-case letters, digits and -, at most 64 characters (the socket refuses anything else)`)
  if (o.chat !== null && (!CHAT_RE.test(o.chat) || o.chat.includes('..'))) throw new Error(`--chat ${JSON.stringify(o.chat)} is not a transcript file name: give the bare *.jsonl name from the project's chats/ folder — no folder, no "..", only letters, digits, ".", "_" and "-" (the socket refuses anything else)`)
  const timerOk = (min) => Number.isFinite(min) && min * 60_000 <= MAX_TIMER_MS
  if (!(o.timeoutMin > 0) || !timerOk(o.timeoutMin)) throw new Error(`--timeout-min must be a positive number of minutes, at most ${Math.floor(MAX_TIMER_MS / 60_000)} (a timer fires a longer delay at once)`)
  if (!(o.holdMin >= 0) || !timerOk(o.holdMin)) throw new Error(`--hold-min must be a number of minutes (0 for no hold), at most ${Math.floor(MAX_TIMER_MS / 60_000)} (a timer fires a longer delay at once)`)
  return o
}

export function dashboardToken(env = process.env) {
  const home = env.CYNCO_HOME || join(homedir(), '.cynco')
  const file = join(home, 'tokens.json')
  const d = JSON.parse(readFileSync(file, 'utf8'))
  const tokens = Array.isArray(d.tokens) ? d.tokens : []
  const t = tokens.find(t => t.name === 'dashboard') ?? tokens.find(t => Array.isArray(t.scopes) && t.scopes.includes('inference'))
  if (!t || typeof t.secret !== 'string') throw new Error(`no dashboard token in ${file}`)
  return t.secret
}

/** The text of a tool result, whatever shape the engine sent it in. */
export function resultText(result) {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : (typeof b === 'string' ? b : JSON.stringify(b))).join('\n')
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text
  return result === undefined ? '' : JSON.stringify(result)
}

/** One line that says what a tool call is about to do. */
export function inputSummary(name, input) {
  const inp = input && typeof input === 'object' ? input : {}
  const cut = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n)
  if (name === 'Bash' && typeof inp.command === 'string') return `command: ${cut(inp.command)}`
  if (name === 'RenderUI') {
    // The tool takes the spec under `spec` or as the input itself (engine/genui/renderUiTool.ts).
    const spec = inp.spec !== undefined ? inp.spec : inp
    const n = spec && typeof spec === 'object' && spec.elements && typeof spec.elements === 'object' ? Object.keys(spec.elements).length : 0
    return `surface=${inp.surface ?? '(none)'} elements=${n}`
  }
  for (const k of ['file_path', 'path', 'pattern', 'query', 'url', 'question', 'name']) if (typeof inp[k] === 'string') return `${k}: ${cut(inp[k])}`
  return cut(JSON.stringify(inp), 160)
}

/** Element type counts of a spec, as "Grid×1 Card×3 Image×12". */
export function typeCounts(spec) {
  const counts = new Map()
  for (const el of Object.values(spec?.elements ?? {})) counts.set(el?.type ?? '?', (counts.get(el?.type ?? '?') ?? 0) + 1)
  return [...counts].map(([t, n]) => `${t}×${n}`).join(' ') || '(empty)'
}

/** Every Image with a prompt in a final frame, with the engine's picture state. */
export function promptedImages(spec) {
  const out = []
  for (const [id, el] of Object.entries(spec?.elements ?? {})) {
    if (!el || el.type !== 'Image' || typeof el.props?.prompt !== 'string') continue
    const img = el.image && typeof el.image === 'object' ? el.image : null
    out.push({ elementId: id, promptLen: el.props.prompt.length, prompt: el.props.prompt, seed: Number.isInteger(el.props.seed) ? el.props.seed : null, status: img?.status ?? '(no state)', key: img?.key ?? null, reason: img?.reason ?? null })
  }
  return out
}

/** A sensible answer to an AskUser card: the first option that says yes/go, else the first option, else a yes. */
export function askAnswer(ev) {
  const opts = Array.isArray(ev.options) ? ev.options.filter(o => typeof o === 'string') : []
  const yes = opts.find(o => /^(yes|ok|okay|go|proceed|continue|approve|do it|all|both)\b/i.test(o.trim()))
  if (yes) return yes
  if (opts.length) return opts[0]
  return 'Yes, go ahead. Show the designs as RenderUI cards with Image prompts; the engine paints them.'
}

/** Does the `project.opened` frame answer the open we sent? */
export function answersOpen(ev, opts) {
  if (ev.slug !== opts.slug) return false
  if (opts.chat) return ev.chat === opts.chat
  return ev.chat === null || ev.chat === undefined
}

/**
 * A refusal at the socket (engine/dashboard/server.ts answers
 * `session.error: command frame refused: <reason>`), with the frame type the
 * reason names when it names one (`project.open: chat must be …`, or
 * `frame type "x" is not allowed …`); null for any other error.
 */
export function commandRefusal(error) {
  const m = /^command frame refused: ([\s\S]*)$/.exec(String(error ?? ''))
  if (!m) return null
  const named = /^([a-z][\w.]*): /.exec(m[1]) ?? /^frame type "([^"]+)" is not allowed/.exec(m[1])
  return { frame: named ? named[1] : null, reason: m[1] }
}

/** The run's finish line for a refusal: the frame it names, else "a command frame". */
export function refusalLine(refused) {
  const why = String(refused?.reason ?? '').slice(0, 200)
  return refused?.frame ? `the engine refused our ${refused.frame} frame — ${why}` : `the engine refused a command frame — ${why}`
}

/** Is this stream.token the stuck-loop halt's own notice? */
export function isStuckHalt(text) {
  return typeof text === 'string' && STUCK_HALT_RE.test(text)
}

/** A tool result's Pictures note: from "Pictures:" to the end of its line, wherever on the line it starts. */
export function picturesNote(text) {
  const m = /\bPictures:[^\n]*/.exec(String(text ?? ''))
  return m ? m[0] : null
}

/**
 * The "the pictures are generating or already made" criterion. `tools` carry
 * { toolId, name, text } and `surfaces` { toolId, final: { images: [{ status }] } | null }.
 * The note is matched anywhere in a RenderUI result: "Pictures: N generating"
 * (", M already made" for a mix) is the note line itself; "Pictures: M already
 * made" alone — every picture made before, the same prompts and seeds again —
 * passes as "Pictures: M already made (nothing painted this run)". The engine
 * cuts the result to RESULT_CAP characters and appends the note last, so
 * validator notes can push it out: for a result at the cap without the note,
 * the call's own final frame (every final frame when its own is not known)
 * says how many pictures it queued (queued or running) and how many were
 * already made (done at the frame). A call that is painting is preferred over
 * one whose pictures were all made.
 */
export function picturesEvidence(tools, surfaces) {
  const renders = tools.filter(t => t.name === 'RenderUI')
  for (const t of renders) {
    const text = String(t.text ?? '')
    const m = PICTURES_RE.exec(text)
    if (m) return { ok: true, evidence: text.slice(m.index).split('\n')[0].slice(0, 200) }
  }
  const withFinal = surfaces.filter(s => s && s.final)
  const cut = []
  for (const t of renders) {
    if (String(t.text ?? '').length < RESULT_CAP || ALREADY_MADE_RE.test(String(t.text))) continue
    const own = withFinal.filter(s => s.toolId === t.toolId)
    const images = (own.length ? own : withFinal).flatMap(s => s.final.images ?? [])
    const n = images.filter(i => i.status === 'queued' || i.status === 'running').length
    const d = images.filter(i => i.status === 'done').length
    if (n > 0) return { ok: true, evidence: `result truncated by the engine; the final frame shows ${n} queued or running${d ? `, ${d} already made` : ''}` }
    cut.push(d)
  }
  for (const t of renders) {
    const m = ALREADY_MADE_RE.exec(String(t.text ?? ''))
    if (m) return { ok: true, evidence: `Pictures: ${m[1]} already made (nothing painted this run)` }
  }
  const made = cut.find(d => d > 0)
  if (made) return { ok: true, evidence: `result truncated by the engine; the final frame shows ${made} already made (nothing painted this run)` }
  if (cut.length) return { ok: false, evidence: 'result truncated by the engine; the final frame shows 0 queued or running, 0 already made' }
  const seen = renders.map(t => picturesNote(t.text) ?? String(t.text ?? '').split('\n')[0].slice(0, 220)).join(' | ')
  return { ok: false, evidence: seen || 'no RenderUI result' }
}

/**
 * The "every picture of the turn reached done" criterion over the turn's
 * pictures (mergePicture's) and the prompted Images the engine did not
 * generate (`notGenerated`: { elementId, status, reason }). A picture already
 * made when its first frame showed it (done at the frame; no ui.image follows)
 * is done: the evidence counts them, and says "nothing painted this run" when
 * that is every picture.
 */
export function everyPictureEvidence(pics, notGenerated = []) {
  const count = (pred) => pics.filter(pred).length
  const notDone = pics.filter(p => p.status !== 'done')
  const made = count(p => p.alreadyMade)
  const requeued = count(p => p.requeues)
  let evidence = `${pics.length} picture(s): ${count(p => p.status === 'done')} done, ${count(p => p.status === 'failed')} failed, ${count(p => p.status === 'queued' || p.status === 'running')} pending; ${notGenerated.length} not generated`
  if (made) evidence += `; ${made} already made at the frame${made === pics.length ? ' (nothing painted this run)' : ''}`
  if (requeued) evidence += `; ${requeued} re-requested after settling`
  if (notDone.length) evidence += ' — ' + notDone.map(p => `${String(p.key).slice(0, 8)} ${p.status}${p.reason ? ` (${String(p.reason).slice(0, 80)})` : ''}`).join(', ')
  if (notGenerated.length) evidence += ' — ' + notGenerated.map(n => `${n.elementId} ${n.status} (${n.reason})`).join(', ')
  return { ok: pics.length > 0 && notDone.length === 0 && notGenerated.length === 0, evidence }
}

/**
 * Every "did not run" / "was not executed" the turn produced: each surface's
 * errors (a withdrawn surface carries the reason it was withdrawn with) and
 * each session.error, anywhere in the text; in a tool result only the engine's
 * own answer for a call it did not run — a result that starts
 * `Tool call "<that call's name>" was not executed: ` (NOT_EXECUTED_RE).
 */
export function didNotRunEvidence({ tools = [], surfaces = [], errors = [] } = {}) {
  const fromSurfaces = surfaces.flatMap(s => s?.errors ?? []).map(String).filter(x => DID_NOT_RUN_RE.test(x))
  const fromTools = tools.filter(t => {
    const m = NOT_EXECUTED_RE.exec(String(t?.text ?? ''))
    return m !== null && (typeof t?.name !== 'string' || m[1] === t.name)
  }).map(t => String(t.text))
  const fromErrors = errors.map(String).filter(x => DID_NOT_RUN_RE.test(x))
  return [...fromSurfaces, ...fromTools, ...fromErrors]
}

/**
 * Fold one prompted Image of a final frame into the picture stored under its
 * key (`ref` is "<surface>/<element>"). New: stored as the frame shows it; one
 * first seen done was already made (the same prompt and seed painted before:
 * no ui.image follows), `alreadyMade`. A picture settled earlier (failed, or
 * done) that a later frame shows queued or running again was re-requested: it
 * takes the frame's status, its reason and times are cleared, it is painted
 * this run, and the run waits for it again. A frame showing it done upgrades
 * it. Returns the picture (a copy) and, for a re-request, what it was.
 */
export function mergePicture(prev, im, ref, now = Date.now()) {
  if (!prev) return { picture: { key: im.key, status: im.status, reason: im.reason ?? null, elementIds: [ref], seed: im.seed, promptLen: im.promptLen, prompt: im.prompt, seenAt: now, runningAt: null, doneAt: null, requeues: 0, earlier: [], alreadyMade: im.status === 'done' }, requeued: null }
  const p = { ...prev, elementIds: prev.elementIds.includes(ref) ? prev.elementIds : [...prev.elementIds, ref] }
  if ((im.status === 'queued' || im.status === 'running') && (p.status === 'failed' || p.status === 'done')) {
    const was = { status: p.status, reason: p.reason ?? null }
    return { picture: { ...p, status: im.status, reason: null, runningAt: null, doneAt: null, requeues: (p.requeues ?? 0) + 1, earlier: [...(p.earlier ?? []), was], alreadyMade: false }, requeued: was }
  }
  if (im.status === 'done' && p.status !== 'done') p.status = 'done'
  return { picture: p, requeued: null }
}

/**
 * The "the turn ended" criterion: `ended` is the governance.session_fidelity
 * after our message, `complete` the message.complete before it (its stop
 * reason), `error` the first session.error of the turn and `stuckHalt` the
 * stuck-loop halt's notice. `rel` turns a time into seconds since the start.
 * It passes only a message.complete with a model stop (NORMAL_STOPS) and no
 * error. session_fidelity alone is the abort exit (a Stop, or a project.open
 * from any tab aborting the turn in startProjectSession): no message.complete,
 * no session.error. stop=halted and stop=max_iterations are the loop giving up.
 */
export function turnEvidence({ ended, complete, error, stuckHalt = null }, rel = (ms) => String(ms)) {
  if (error) return { ok: false, evidence: `session.error at +${rel(error.at)}s: ${String(error.text).slice(0, 300)}${ended ? '' : ' (no governance.session_fidelity followed)'}` }
  if (!ended) return { ok: false, evidence: complete ? `message.complete stop=${complete.stopReason} at +${rel(complete.at)}s, but no governance.session_fidelity followed` : 'never (no governance.session_fidelity after the message)' }
  if (!complete) return { ok: false, evidence: `aborted: governance.session_fidelity at +${rel(ended.at)}s with no message.complete and no session.error (a Stop, or a project.open from any tab, ends a turn this way)` }
  const stop = complete.stopReason
  if (stuckHalt) return { ok: false, evidence: `halted: the stuck-loop halt at +${rel(stuckHalt.at)}s (message.complete stop=${stop})` }
  if (stop === 'halted') return { ok: false, evidence: `halted: message.complete stop=halted at +${rel(complete.at)}s` }
  if (stop === 'max_iterations') return { ok: false, evidence: `stopped at max_iterations: message.complete stop=max_iterations at +${rel(complete.at)}s` }
  if (!NORMAL_STOPS.has(stop)) return { ok: false, evidence: `message.complete stop=${stop} at +${rel(complete.at)}s is not a model stop (${[...NORMAL_STOPS].join(', ')})` }
  return { ok: true, evidence: `stop=${stop} at +${rel(complete.at)}s` }
}

/**
 * Per-type rate limit for the hold's lines: one line per type per `everyMs`;
 * returns null to stay quiet, else how many it held back since that type's
 * last line. `.drain()` hands over (and zeroes) what is still held back, for
 * a last line before a close or the hold's end.
 */
export function frameThrottle(everyMs = HOLD_LINE_EVERY_MS) {
  const last = new Map()
  const allow = (type, now = Date.now()) => {
    const e = last.get(type)
    if (e && now - e.at < everyMs) { e.held += 1; return null }
    last.set(type, { at: now, held: 0 })
    return { held: e ? e.held : 0 }
  }
  allow.drain = () => {
    const out = []
    for (const [type, e] of last) if (e.held > 0) { out.push({ type, held: e.held }); e.held = 0 }
    return out
  }
  return allow
}

/** A few identifying fields of a frame, for the hold's one line per type. */
export function frameBrief(ev) {
  const parts = []
  for (const k of ['slug', 'chat', 'surfaceId', 'toolName', 'status', 'stopReason']) if (typeof ev?.[k] === 'string') parts.push(`${k}=${ev[k].slice(0, 60)}`)
  if (typeof ev?.key === 'string') parts.push(`key=${ev.key.slice(0, 8)}`)
  if (ev?.error !== undefined) parts.push(`error=${JSON.stringify(String(ev.error).slice(0, 160))}`)
  return parts.join(' ')
}

/** The help: the header comment, up to the first line that is not a comment. */
export function usageText(source) {
  const out = []
  for (const l of String(source).split(/\r?\n/)) {
    if (!l.startsWith('//')) break
    out.push(l.replace(/^\/\/ ?/, ''))
  }
  return out.join('\n')
}

function usage() {
  return usageText(readFileSync(new URL(import.meta.url), 'utf8'))
}

/**
 * The run; resolves to the exit code. `env` is where the dashboard token is
 * read from (CYNCO_HOME); `settleMs` is the wait after the socket opens before
 * our project.open — a test against a scripted socket shortens it.
 */
export async function main(argv, { env = process.env, settleMs = SETTLE_MS } = {}) {
  const opts = parseArgs(argv)
  if (opts.help) { console.log(usage()); return 0 }
  if (!opts.message) throw new Error('--message or --message-file is required')
  const token = dashboardToken(env)
  const wsUrl = opts.base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token)

  const t0 = Date.now()
  const lines = []
  const log = (line) => { const s = `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${new Date().toISOString().slice(11, 23)} ${line}`; lines.push(s); console.log(s) }
  const secs = (ms) => ((ms - t0) / 1000).toFixed(1)

  const state = {
    opened: null, chatFile: opts.chat, openSentAt: null, messageSentAt: null,
    surfaces: new Map(), // toolId → { surfaceId, partials, final, finalAt, errors }
    pictures: new Map(), // key → { key, status, reason, elementIds, seed, promptLen, seenAt, runningAt, doneAt, requeues, earlier, alreadyMade }
    notGenerated: [],    // { surfaceId, elementId, status, reason }
    tools: [],           // { toolId, name, startedAt, summary, isError, firstLine, picturesLine, text, completedAt }
    approvals: [], asks: [], errors: [], complete: null, tokens: 0,
    turnEnded: null,     // { at, stopReason, error } — the governance.session_fidelity after our message
    turnError: null,     // { at, text } — the first session.error of our turn
    stuckHalt: null,     // { at } — the stuck-loop halt's notice in our turn
    notOurs: [],         // { at, type, text } — frames that are not our turn's: a session.error from another tab, and after our turn ended another turn's frames
    firstPartialAt: null, firstFinalAt: null, closed: null, finished: false, exitCode: null, reason: null,
    afterVerdict: false, holding: false, closingSelf: false,
  }

  const ws = new WebSocket(wsUrl)
  const send = (frame) => { ws.send(JSON.stringify(frame)); return frame }
  const pending = () => [...state.pictures.values()].filter(p => p.status === 'queued' || p.status === 'running')
  const holdLine = frameThrottle()
  const drainHold = () => { for (const { type, held } of holdLine.drain()) log(`[driver] hold: ${type} (+${held} more since the last line)`) }

  let resolveDone = () => {}
  const done = new Promise(r => { resolveDone = r })
  let holdResolve = () => {}
  const timers = []

  function finish(reason, code) {
    if (state.finished) return
    state.finished = true; state.reason = reason; state.exitCode = code
    log(`[driver] finished: ${reason}`)
    resolveDone()
  }
  function maybeFinish() {
    if (state.finished || !state.turnEnded) return
    if (pending().length === 0) finish(`the turn ended${state.turnError ? ' in a session.error' : state.complete ? '' : ' with no message.complete'} and every picture is settled`, 0)
  }
  /** A frame that is not our turn's: logged, kept for the summary, never counted. */
  function notOurs(type, text, why) {
    state.notOurs.push({ at: Date.now(), type, text })
    log(`${type} (${why}; not this turn's): ${text.slice(0, 300)}`)
  }
  /** Surfaces another turn drew after ours ended: one line for the first partial frame, one for the final. */
  const foreignSurfaces = new Set()

  ws.addEventListener('open', () => {
    log(`[driver] socket open ${opts.base}/ws`)
    timers.push(setTimeout(() => {
      state.openSentAt = Date.now()
      const frame = { type: 'project.open', slug: opts.slug }
      if (opts.chat) frame.chat = opts.chat
      send(frame)
      log(`[driver] sent project.open slug=${opts.slug} chat=${opts.chat ?? '(new chat)'}`)
      timers.push(setTimeout(() => { if (!state.opened) { state.errors.push('project.opened never arrived'); log('[driver] FAIL project.opened did not answer within 60 s'); finish('project did not open', 4) } }, OPEN_TIMEOUT_MS))
    }, settleMs))
  })
  ws.addEventListener('error', (e) => { log(`[driver] socket error: ${e?.message ?? e?.type ?? 'error'}`) })
  ws.addEventListener('close', (e) => {
    // Our own close after the verdict (and the hold) is not the engine going away.
    if (state.closingSelf) return
    if (state.afterVerdict) drainHold()
    state.closed = { code: e?.code ?? null, reason: e?.reason ?? '', at: Date.now() }
    log(`[driver] socket closed code=${e?.code ?? '?'}${e?.reason ? ` reason=${e.reason}` : ''}`)
    if (!state.finished) finish('the socket closed before the turn settled', 3)
    else if (state.holding) { log('[driver] (holding: the engine went away under an open socket)'); holdResolve() }
  })

  ws.addEventListener('message', (m) => {
    let ev
    try { ev = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)) } catch { log(`[driver] non-JSON frame (${String(m.data).length} chars)`); return }
    if (!ev || typeof ev.type !== 'string') return
    if (state.afterVerdict) {
      // After the verdict (the hold): one line per frame type a second at most,
      // so a restart test sees what the engine still sent before the close.
      const r = holdLine(ev.type)
      if (r) { const brief = frameBrief(ev); log(`[driver] hold: ${ev.type}${brief ? ` ${brief}` : ''}${r.held ? ` (+${r.held} more since the last line)` : ''}`) }
      // A card the engine waits on is still answered; nothing else is counted.
      if (ev.type !== 'approval.request' && ev.type !== 'ask.request') return
    }
    switch (ev.type) {
      case 'project.opened': {
        const answers = !state.opened && state.openSentAt !== null && answersOpen(ev, opts)
        log(`project.opened slug=${ev.slug} chat=${ev.chat ?? 'null'} title=${JSON.stringify(ev.title ?? null)}${state.openSentAt === null ? ' (sent on connect, before our open)' : answers ? '' : ' (not the answer to our open)'}`)
        if (answers) {
          state.opened = { at: Date.now(), chat: ev.chat ?? null, title: ev.title ?? null }
          if (ev.chat) state.chatFile = ev.chat
          send({ type: 'user.message', text: opts.message })
          state.messageSentAt = Date.now()
          log(`[driver] sent user.message (${opts.message.length} chars): ${JSON.stringify(opts.message.slice(0, 120))}${opts.message.length > 120 ? '…' : ''}`)
        }
        break
      }
      case 'project.ingest': {
        if (ev.kind === 'chat' && typeof ev.filePath === 'string') { state.chatFile = basename(ev.filePath); log(`project.ingest chat=${state.chatFile} indexed=${ev.indexed}${ev.reason ? ` reason=${ev.reason}` : ''}`) }
        break
      }
      case 'session.error': {
        const text = String(ev.error)
        const refused = commandRefusal(text)
        // Not our turn's: anything after our turn ended (another turn — a queued
        // click, the operator typing on the page), and a "project.open refused"
        // once our open was answered (main.ts broadcasts another tab's refusal).
        const elsewhere = state.turnEnded ? 'after our turn ended' : (state.opened && /^project\.open refused/.test(text)) ? "another tab's project.open" : null
        if (elsewhere) {
          notOurs('session.error', text, elsewhere)
          // The socket answers a refusal to its sender only: the frame was ours.
          if (refused) finish(refusalLine(refused), 4)
          break
        }
        state.errors.push(text)
        log(`session.error: ${text.slice(0, 300)}`)
        if (!state.opened) {
          // main.ts answers "project.open refused: …"; the socket refuses a bad shape itself.
          if (state.openSentAt !== null && (/project\.open refused/.test(text) || refused?.frame === 'project.open')) finish(`project.open refused — ${text.slice(0, 200)}`, 4)
          break
        }
        if (!state.messageSentAt) break
        if (!state.turnError) state.turnError = { at: Date.now(), text }
        if (refused) finish(refusalLine(refused), 4)
        break
      }
      case 'stream.token': {
        state.tokens += 1
        if (state.messageSentAt && !state.turnEnded && !state.stuckHalt && isStuckHalt(ev.text)) {
          state.stuckHalt = { at: Date.now() }
          log(`stream.token: the stuck-loop halt — ${String(ev.text).replace(/\s+/g, ' ').trim().slice(0, 160)}`)
        }
        break
      }
      case 'ui.render': {
        if (!state.messageSentAt) { log(`ui.render (before our message; ignored) surface=${ev.surfaceId} partial=${ev.partial}`); break }
        let s = state.surfaces.get(ev.toolId)
        // After our turn ended, a surface we never saw is another turn's. One of
        // ours still counts: runTurn's finally withdraws a surface left open
        // (closePendingUiSurfaces) after the turn's session_fidelity.
        if (!s && state.turnEnded) {
          if (!ev.partial || !foreignSurfaces.has(ev.toolId)) {
            const what = ev.partial ? '' : ev.spec ? ` ${typeCounts(ev.spec)}; prompted Images: ${promptedImages(ev.spec).length}` : ` spec=null errors=${JSON.stringify(ev.errors ?? [])}`
            notOurs('ui.render', `${ev.partial ? 'partial' : 'FINAL'} surface=${ev.surfaceId} toolId=${ev.toolId}${what}`, 'after our turn ended')
          }
          foreignSurfaces.add(ev.toolId)
          break
        }
        if (!s) { s = { toolId: ev.toolId, surfaceId: ev.surfaceId, partials: 0, final: null, finalAt: null, errors: [] }; state.surfaces.set(ev.toolId, s) }
        if (ev.partial) {
          s.partials += 1
          if (!state.firstPartialAt) state.firstPartialAt = Date.now()
          if (s.partials <= 3 || s.partials % 10 === 0) log(`ui.render partial #${s.partials} surface=${ev.surfaceId} ${typeCounts(ev.spec)}`)
          break
        }
        s.surfaceId = ev.surfaceId
        s.finalAt = Date.now()
        if (!state.firstFinalAt) state.firstFinalAt = s.finalAt
        if (Array.isArray(ev.errors)) s.errors.push(...ev.errors.map(String))
        if (!ev.spec) { s.final = { types: '(withdrawn)', images: [] }; log(`ui.render FINAL surface=${ev.surfaceId} spec=null errors=${JSON.stringify(ev.errors ?? [])}`); break }
        const images = promptedImages(ev.spec)
        s.final = { types: typeCounts(ev.spec), images: images.map(({ prompt, ...rest }) => rest) }
        log(`ui.render FINAL surface=${ev.surfaceId} ${s.final.types}; prompted Images: ${images.length} (${images.filter(i => i.seed !== null).length} with a seed)${ev.errors?.length ? ` errors=${JSON.stringify(ev.errors)}` : ''}`)
        for (const im of images) {
          log(`  Image ${im.elementId}: seed=${im.seed ?? '(derived)'} prompt=${im.promptLen} chars → ${im.status}${im.key ? ` key=${im.key.slice(0, 8)}` : ''}${im.reason ? ` (${im.reason})` : ''}`)
          if (im.key && ['queued', 'running', 'done', 'failed'].includes(im.status)) {
            const { picture, requeued } = mergePicture(state.pictures.get(im.key), im, `${ev.surfaceId}/${im.elementId}`)
            state.pictures.set(im.key, picture)
            if (requeued) log(`  picture ${im.key.slice(0, 8)} re-requested after it ${requeued.status === 'failed' ? 'failed' : 'was done'}${requeued.reason ? ` (${requeued.reason.slice(0, 120)})` : ''} → ${im.status}; waiting for it again (${pending().length} pending)`)
          } else {
            state.notGenerated.push({ surfaceId: ev.surfaceId, elementId: im.elementId, status: im.status, reason: im.reason })
          }
        }
        break
      }
      case 'ui.image': {
        const k8 = String(ev.key).slice(0, 8)
        // A key hashes how a picture is made, not where: another project asking the same
        // prompt and seed runs its own job under the same key (engine/imagegen/CLAUDE.md).
        if (typeof ev.slug === 'string' && ev.slug !== opts.slug) { log(`ui.image ${k8} ${ev.status} (another project's, slug=${ev.slug}; not this turn's)`); break }
        const p = state.pictures.get(ev.key)
        if (!p) { log(`ui.image ${k8} ${ev.status}${ev.reason ? ` — ${ev.reason}` : ''} (not one of this turn's pictures)`); break }
        if (ev.status === 'running') { p.runningAt = p.runningAt ?? Date.now(); p.status = 'running'; log(`ui.image ${k8} running`); break }
        p.status = ev.status; p.reason = ev.reason ?? null; p.doneAt = Date.now()
        const gen = p.runningAt ? ` (${((p.doneAt - p.runningAt) / 1000).toFixed(1)} s since running)` : ''
        log(`ui.image ${k8} ${ev.status}${gen}${ev.reason ? ` — ${ev.reason}` : ''}; ${pending().length} still pending`)
        maybeFinish()
        break
      }
      case 'tool.start': {
        if (!state.messageSentAt) break
        // Another turn's call (a click re-dispatched after ours, the operator typing on the page): never ours.
        if (state.turnEnded) { notOurs('tool.start', `${ev.toolName} ${inputSummary(ev.toolName, ev.input)}`, 'after our turn ended'); break }
        const t = { toolId: ev.toolId, name: ev.toolName, startedAt: Date.now(), summary: inputSummary(ev.toolName, ev.input), isError: null, firstLine: null, picturesLine: null, text: '', completedAt: null }
        state.tools.push(t)
        log(`tool.start ${ev.toolName} ${t.summary}${ev.toolName === 'Bash' ? '  <-- a Bash call in a picture turn' : ''}`)
        break
      }
      case 'tool.complete': {
        if (!state.messageSentAt) break
        if (state.turnEnded) {
          const text = resultText(ev.result)
          const note = picturesNote(text)
          notOurs('tool.complete', `${ev.toolName} isError=${!!ev.isError}: ${text.split('\n')[0].slice(0, 220)}${note ? ` | ${note}` : ''}`, 'after our turn ended')
          break
        }
        let t = state.tools.find(x => x.toolId === ev.toolId)
        if (!t) { t = { toolId: ev.toolId, name: ev.toolName, startedAt: null, summary: '(no tool.start seen)', isError: null, firstLine: null, picturesLine: null, text: '', completedAt: null }; state.tools.push(t) }
        const text = resultText(ev.result)
        t.text = text; t.isError = !!ev.isError; t.completedAt = Date.now()
        t.firstLine = text.split('\n')[0].slice(0, 220)
        t.picturesLine = picturesNote(text)
        log(`tool.complete ${ev.toolName} isError=${t.isError}: ${t.firstLine}${t.picturesLine ? `\n        ${t.picturesLine.slice(0, 300)}` : ''}${text.length >= RESULT_CAP ? ` [result at the engine's ${RESULT_CAP}-char cap]` : ''}`)
        break
      }
      case 'approval.request': {
        // The engine waits on the card whoever's turn it is: always answered; after our turn ended, not ours.
        const line = `${ev.toolName} risk=${ev.risk}: ${String(ev.description ?? '').replace(/\s+/g, ' ').slice(0, 240)} → answered approved:false`
        if (state.turnEnded) { send({ type: 'approval.response', requestId: ev.requestId, approved: false }); notOurs('approval.request', line, 'after our turn ended'); break }
        state.approvals.push({ requestId: ev.requestId, toolName: ev.toolName, description: String(ev.description ?? '').slice(0, 400), risk: ev.risk, at: Date.now() })
        send({ type: 'approval.response', requestId: ev.requestId, approved: false })
        log(`approval.request FAIL-MARK ${line}`)
        break
      }
      case 'ask.request': {
        const answer = askAnswer(ev)
        const line = `${String(ev.question ?? '').replace(/\s+/g, ' ').slice(0, 240)} options=${JSON.stringify(ev.options ?? null)} → answered ${JSON.stringify(answer)}`
        if (state.turnEnded) { send({ type: 'ask.answer', requestId: ev.requestId, answer }); notOurs('ask.request', line, 'after our turn ended'); break }
        state.asks.push({ requestId: ev.requestId, question: String(ev.question ?? '').slice(0, 400), options: ev.options ?? null, answer, at: Date.now() })
        send({ type: 'ask.answer', requestId: ev.requestId, answer })
        log(`ask.request: ${line}`)
        break
      }
      case 'message.complete': {
        if (!state.messageSentAt) break
        // Another turn's (a queued click, the operator typing on the page): never ours.
        if (state.turnEnded) { notOurs('message.complete', `stop=${ev.stopReason ?? 'null'}`, 'after our turn ended'); break }
        state.complete = { at: Date.now(), stopReason: ev.stopReason ?? null, usage: ev.usage ?? null }
        log(`message.complete stop=${ev.stopReason ?? 'null'}${ev.usage ? ` usage=${JSON.stringify(ev.usage)}` : ''}; pictures pending: ${pending().length}`)
        break
      }
      case 'governance.session_fidelity': {
        // The turn's end: one per user message on every exit path (F158), an
        // engine error included — which sends no message.complete.
        if (!state.messageSentAt) break
        if (state.turnEnded) { notOurs('governance.session_fidelity', 'another turn ended', 'after our turn ended'); break }
        state.turnEnded = { at: Date.now(), stopReason: state.complete?.stopReason ?? null, error: state.turnError?.text ?? null }
        log(`governance.session_fidelity: the turn ended (${state.turnError ? `session.error: ${state.turnError.text.slice(0, 200)}` : `stop=${state.complete?.stopReason ?? '(no message.complete: aborted)'}`}); pictures pending: ${pending().length}`)
        maybeFinish()
        break
      }
      default: break
    }
  })

  timers.push(setInterval(() => { if (typeof ws.ping === 'function' && ws.readyState === 1) { try { ws.ping() } catch {} } }, PING_EVERY_MS))
  timers.push(setInterval(() => { if (!state.finished) log(`[driver] heartbeat: ${state.tokens} stream tokens, ${state.tools.length} tool calls, ${state.surfaces.size} surfaces, ${pending().length} pictures pending`) }, HEARTBEAT_MS))
  timers.push(setTimeout(() => finish(`deadline of ${opts.timeoutMin} min reached`, 2), opts.timeoutMin * 60_000))

  await done
  state.afterVerdict = true

  // ── the verdict ─────────────────────────────────────────────
  const checks = []
  const check = (name, ok, evidence) => { checks.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${evidence}`) }
  const surfaces = [...state.surfaces.values()]
  const finals = surfaces.filter(s => s.final && s.final.types !== '(withdrawn)')
  const prompted = finals.flatMap(s => s.final.images)
  const seeded = prompted.filter(i => i.seed !== null)
  check('a final RenderUI frame with prompted Images carrying a seed', finals.length > 0 && seeded.length > 0, `${finals.length} final frame(s), ${prompted.length} prompted Image(s), ${seeded.length} with a seed`)
  const pictures = picturesEvidence(state.tools, surfaces)
  check('a RenderUI result says the pictures are generating or already made', pictures.ok, pictures.evidence)
  const bash = state.tools.filter(t => t.name === 'Bash')
  check('no Bash call', bash.length === 0, bash.length ? bash.map(b => `${b.summary} → ${b.isError ? 'ERROR ' : ''}${b.firstLine}`).join(' | ').slice(0, 600) : 'none')
  check('no approval.request', state.approvals.length === 0, state.approvals.length ? state.approvals.map(a => `${a.toolName}: ${a.description.slice(0, 120)}`).join(' | ') : 'none')
  const didNotRun = didNotRunEvidence({ tools: state.tools, surfaces, errors: state.errors })
  check('no "did not run"', didNotRun.length === 0, didNotRun.length ? `${didNotRun[0].slice(0, 200)}${didNotRun.length > 1 ? ` (+${didNotRun.length - 1} more)` : ''}` : 'none')
  const turn = turnEvidence({ ended: state.turnEnded, complete: state.complete, error: state.turnError, stuckHalt: state.stuckHalt }, secs)
  check('the turn ended', turn.ok, turn.evidence)
  const pics = [...state.pictures.values()]
  const every = everyPictureEvidence(pics, state.notGenerated)
  check('every picture of the turn reached done', every.ok, every.evidence)
  if (opts.projectDir) {
    const problems = []
    for (const p of pics) {
      const png = join(opts.projectDir, 'images', `${p.key}.png`), json = join(opts.projectDir, 'images', `${p.key}.json`)
      if (!existsSync(png)) { problems.push(`${p.key.slice(0, 8)}: no png`); continue }
      if (!existsSync(json)) { problems.push(`${p.key.slice(0, 8)}: no sidecar`); continue }
      let sc
      try { sc = JSON.parse(readFileSync(json, 'utf8')) } catch (e) { problems.push(`${p.key.slice(0, 8)}: sidecar unreadable (${e.message})`); continue }
      if (sc.status !== 'done') problems.push(`${p.key.slice(0, 8)}: sidecar status ${sc.status}`)
      const wantFrom = p.seed !== null ? 'model' : 'prompt'
      if (sc.seedFrom !== wantFrom) problems.push(`${p.key.slice(0, 8)}: seedFrom ${sc.seedFrom} (wanted ${wantFrom})`)
      if (p.seed !== null && sc.seed !== p.seed) problems.push(`${p.key.slice(0, 8)}: seed ${sc.seed} (Image said ${p.seed})`)
      if (typeof sc.prompt !== 'string' || sc.prompt.length !== p.promptLen) problems.push(`${p.key.slice(0, 8)}: prompt ${typeof sc.prompt === 'string' ? sc.prompt.length : 'missing'} chars (Image had ${p.promptLen})`)
      p.sidecar = { seed: sc.seed, seedFrom: sc.seedFrom, promptLen: typeof sc.prompt === 'string' ? sc.prompt.length : null, checkpoint: sc.checkpoint, steps: sc.steps, cfg: sc.cfg, queueMs: sc.queueMs, genMs: sc.genMs, execMs: sc.execMs, bytes: sc.bytes }
    }
    check('each picture has images/<key>.png and a sidecar with its seed and full prompt', pics.length > 0 && problems.length === 0, problems.length ? problems.join('; ').slice(0, 600) : `${pics.length} sidecar(s) match (seedFrom, seed, prompt length)`)
  }

  const timeline = {
    projectOpenedS: state.opened ? Number(secs(state.opened.at)) : null,
    messageSentS: state.messageSentAt ? Number(secs(state.messageSentAt)) : null,
    firstPartialFrameS: state.firstPartialAt ? Number(secs(state.firstPartialAt)) : null,
    firstFinalFrameS: state.firstFinalAt ? Number(secs(state.firstFinalAt)) : null,
    messageCompleteS: state.complete ? Number(secs(state.complete.at)) : null,
    turnEndedS: state.turnEnded ? Number(secs(state.turnEnded.at)) : null,
    lastPictureS: pics.some(p => p.doneAt) ? Number(secs(Math.max(...pics.filter(p => p.doneAt).map(p => p.doneAt)))) : null,
    perPictureS: pics.filter(p => p.runningAt && p.doneAt).map(p => Number(((p.doneAt - p.runningAt) / 1000).toFixed(1))),
  }
  log(`[driver] timeline: ${JSON.stringify(timeline)}`)
  const allPass = checks.every(c => c.ok)
  const code = state.exitCode !== 0 ? state.exitCode : (allPass ? 0 : 1)
  log(`[driver] verdict: ${allPass ? 'PASS' : 'FAIL'} (${checks.filter(c => c.ok).length}/${checks.length} criteria), exit ${code}`)

  if (opts.summary) {
    const summary = { startedAt: new Date(t0).toISOString(), base: opts.base, slug: opts.slug, chatFile: state.chatFile, message: opts.message, reason: state.reason, exitCode: code, checks, timeline, surfaces, pictures: pics.map(({ prompt, ...p }) => p), notGenerated: state.notGenerated, tools: state.tools.map(({ text, ...t }) => ({ ...t, textChars: text.length })), approvals: state.approvals, asks: state.asks, errors: state.errors, complete: state.complete, turnEnded: state.turnEnded, turnError: state.turnError, stuckHalt: state.stuckHalt, notOurs: state.notOurs, closed: state.closed, log: lines }
    mkdirSync(dirname(opts.summary), { recursive: true })
    writeFileSync(opts.summary, JSON.stringify(summary, null, 2))
    log(`[driver] summary written to ${opts.summary}`)
  }

  if (opts.holdMin > 0 && ws.readyState === 1) {
    state.holding = true
    log(`[driver] holding the socket open for ${opts.holdMin} min (an engine restart now shows as a close; each frame type the engine still sends is logged, one line a second at most)`)
    await new Promise(r => { holdResolve = r; timers.push(setTimeout(r, opts.holdMin * 60_000)) })
    state.holding = false
    drainHold()
    log('[driver] hold over')
  }
  for (const t of timers) { clearTimeout(t); clearInterval(t) }
  state.closingSelf = true
  try { ws.close() } catch {}
  return code
}

const isMain = process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)
if (isMain) {
  main(process.argv.slice(2)).then(code => { setTimeout(() => process.exit(code), 100) }).catch(e => { console.error(`[driver] ${e?.stack ?? e}`); process.exit(5) })
}
