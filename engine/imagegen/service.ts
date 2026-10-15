/**
 * engine/imagegen/service.ts — RenderUI Image prompts painted on the
 * operator's ComfyUI, one job at a time, beside the turn and never inside it.
 *
 * The loop calls `annotate` (synchronous, never throws) on the final spec of a
 * RenderUI call in a project chat. Each Image with a `prompt` gets an
 * engine-only `image` state on its element — a placeholder the surface draws
 * at once — and, unless the picture is already made or already in flight, a
 * job. `start()`, run after the final frame is emitted, kicks the worker.
 * `warm()`, run at the start of every project-chat turn, probes in the
 * background (at most every 30 s), so the checkpoint a key names is the one
 * the server has when the turn's pictures are asked; a failed probe never
 * replaces a good one still inside its 10 minutes, so a blip at a turn's
 * warm-up fails no queued job. The
 * worker probes the server when its last answer is stale, fills the workflow,
 * writes the sidecar `running` BEFORE the POST, polls `/history`, downloads
 * the one saved PNG into `images/<key>.png`, writes the sidecar `done`,
 * journals and emits `ui.image` in one synchronous step, then commits. Every
 * failure becomes a named reason on the sidecar, in the journal, in a
 * `ui.image failed` event and in the log; nothing throws.
 *
 * A job the worker gives up on after its POST may have reached ComfyUI (a
 * lost answer, polls that stop answering, the deadline) is interrupted and
 * dequeued by id before the next job goes out, so the engine never has two
 * prompts on the server. Nothing is written through a link the model planted
 * (`storeFault`, checked at annotate, at job start and at the write).
 *
 * An abort, halt or project switch leaves jobs alone: each captured its
 * project at annotate time and finishes into it. `shutdown` interrupts the one
 * in flight (by prompt_id only, and only while ComfyUI may still hold it) and
 * marks it and every queued job failed.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UiImageEvent, UiImageState, UiSpec } from '../bridge/protocol.js'
import { commitHistory, ensureHistory } from '../projects/history.js'
import { appendJournal, sha256Of } from '../projects/layout.js'
import { ComfyClient, ComfyError, probeComfy, type HistoryEntry, type ProbeResult } from './client.js'
import { comfyConfig, DOWNLOAD_CAP_BYTES, PER_CALL_CAP, POLL_MS, QUEUE_CAP, UNSET_REASON, type ComfyConfig } from './config.js'
import { annotateFileImages, ensureImageIgnore, FILES_ONLY_REASON, imageKey, imagesDir, isProjectFile, originKey, partPath, pngPath, promptedImages, readSidecar, recordOrigins, RUN_ID, seedFor, storeFault, writeSidecar, type ImageRef, type ImageSidecar, type KeyFields } from './store.js'
import { fillWorkflow } from './workflow.js'

export type AnnotateAt = {
  /** The bound project chat, or null (a coding session: pictures are project-only). */
  project: { dir: string; slug: string; chatFile: string } | null
  toolId: string
  surfaceId: string
  /** The call's arguments were cut off mid-stream: its pictures wait for the re-issued call. */
  cutOff: boolean
}
/** `note` goes after "(surface: id)" in the tool result; `start` runs after the final frame is emitted. */
export type Annotation = { note: string | null; start(): void }
/** What `ConversationLoop` holds; it calls `warm` at the start of every project-chat turn (synchronous, never throws). */
export type ImageAnnotator = { annotate(spec: UiSpec, at: AnnotateAt): Annotation; warm?(): void }

export type ImageServiceDeps = {
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  emit: (e: UiImageEvent) => void
  now?: () => number
  log?: (line: string) => void
  /** Test seams; the env clamps apply only to env values. */
  pollMs?: number
  timeoutMs?: number
}

export const PROJECT_ONLY_REASON = 'pictures are generated in project chats only'
export const CUT_OFF_REASON = 'the call was cut off; pictures are generated when it is re-issued'
export const CAP_REASON = `only the first ${PER_CALL_CAP} pictures in a surface are generated`
export const QUEUE_FULL_REASON = `the picture queue is full (${QUEUE_CAP} waiting); ask again when these finish`
export const STOPPED_REASON = 'the engine stopped before this picture finished — ask for it again'
const STOPPING_REASON = 'the engine is shutting down'

const PROBE_FAIL_TTL_MS = 60_000
const PROBE_OK_TTL_MS = 10 * 60_000
/** `warm` starts no probe while the last one finished less than this long ago, whatever it answered. */
export const WARM_MIN_AGE_MS = 30_000
const SHUTDOWN_BOUND_MS = 3000
/** Consecutive failed /history polls before the job fails with the last one's reason. */
const POLL_FAILURES_TOLERATED = 3

type Job = {
  /** dir|key: one job per picture per project, however many surfaces show it. */
  id: string
  dir: string
  slug: string
  key: string
  sidecar: ImageSidecar
  queuedAt: number
  status: 'queued' | 'running'
  /**
   * The checkpoint an ask keyed on it pinned this queued `'auto'` job to (`autoTwin`, F179), also written into
   * `sidecar.checkpoint`, which `runJob` paints; null while unpinned. Unpinned when that checkpoint is found gone — the
   * job's probe no longer lists it (`runJob`) or ComfyUI refuses it (`dropVanished`) — so the job takes its probe's pick.
   */
  pinned: string | null
  /**
   * Set when the POST goes out: resolves to the id of the prompt ComfyUI may
   * hold for this job (the server's once it answers, else the one sent), or
   * null when it holds nothing (a 400 refusal). Cleared once the history
   * entry arrives or the worker withdraws the prompt itself, so shutdown only
   * ever cancels a prompt of ours that may still be pending or running.
   */
  onServer: Promise<string | null> | null
  settled: boolean
}

type Outcome = { status: 'done' } | { status: 'failed'; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const secs = (ms: number) => (ms / 1000).toFixed(1)
const iso = (ms: number) => new Date(ms).toISOString()
const noop = () => {}

function notGeneratedNote(reason: string): string {
  return `Pictures: not generated — ${reason}. The cards show their alt text; tell the user if they want pictures.`
}

/** The ComfyUI-side failure in a finished history entry, or null when it succeeded. */
function historyFailure(entry: HistoryEntry): string | null {
  const msgs = Array.isArray(entry.status.messages) ? entry.status.messages : []
  const find = (name: string): unknown => (msgs.find(m => Array.isArray(m) && m[0] === name) as unknown[] | undefined)?.[1]
  const err = find('execution_error')
  if (isObj(err)) {
    const node = typeof err.node_type === 'string' ? err.node_type : 'a node'
    const id = typeof err.node_id === 'string' || typeof err.node_id === 'number' ? String(err.node_id) : '?'
    const full = typeof err.exception_message === 'string' ? err.exception_message.trim() : 'no message'
    const oom = /out of memory|outofmemory|allocat/i.test(`${full} ${typeof err.exception_type === 'string' ? err.exception_type : ''}`)
    return `ComfyUI failed in ${node} (node ${id}): ${full.slice(0, 200)}${oom ? ' — out of GPU memory; lower LOCALCODE_COMFYUI_SIZE' : ''}`
  }
  if (find('execution_interrupted') !== undefined) return 'interrupted on the ComfyUI PC'
  if (entry.status.status_str === 'error') return 'ComfyUI reported an error and said nothing about it'
  return null
}

/**
 * Every saved output of `kind` (images now; a later 3D step reads "3d"),
 * iterated generically by node id. Only `type: 'output'` counts: a
 * PreviewImage's `temp` file is not the result.
 */
function outputRefs(outputs: Record<string, unknown>, kind = 'images'): ImageRef[] {
  const refs: ImageRef[] = []
  for (const nodeId of Object.keys(outputs)) {
    const node = outputs[nodeId]
    const list = isObj(node) ? node[kind] : undefined
    if (!Array.isArray(list)) continue
    for (const r of list) {
      if (isObj(r) && r.type === 'output' && typeof r.filename === 'string') refs.push({ filename: r.filename, subfolder: typeof r.subfolder === 'string' ? r.subfolder : '', type: 'output' })
    }
  }
  return refs
}

/** ComfyUI's own execution time, from its execution_start → execution_success timestamps. */
function execMsOf(entry: HistoryEntry): number | null {
  const msgs = Array.isArray(entry.status.messages) ? entry.status.messages : []
  const at = (name: string): number | null => {
    const m = msgs.find(x => Array.isArray(x) && x[0] === name) as unknown[] | undefined
    return m && isObj(m[1]) && typeof m[1].timestamp === 'number' ? m[1].timestamp : null
  }
  const a = at('execution_start'), b = at('execution_success')
  return a !== null && b !== null && b >= a ? b - a : null
}

function reasonOf(e: unknown): string {
  return e instanceof ComfyError ? e.reason : `the engine failed while making this picture (${errText(e)})`
}

/**
 * A good probe `r` with `name` taken off its checkpoint list (and its count); `r` itself when it is a failure or its
 * list does not name it. For a list read before `name` left the server while the pick was already another (F179).
 */
function withoutCheckpoint(r: ProbeResult, name: string): ProbeResult {
  if (!r.ok || !r.checkpoints?.includes(name)) return r
  const checkpoints = r.checkpoints.filter(c => c !== name)
  return { ...r, checkpoints, checkpointCount: checkpoints.length }
}

export class ImageService implements ImageAnnotator {
  private readonly config: { ok: true; cfg: ComfyConfig } | { ok: false; reason: string }
  private readonly client: ComfyClient | null
  private readonly emitFn: (e: UiImageEvent) => void
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly fetchFn: typeof fetch
  private readonly pollMs: number
  private readonly timeoutMs: number
  /**
   * The probe a job trusts (`ensureReady`): a failure for 60 s, a success for 10 minutes, which no failure replaces (F179).
   * `dropVanished` clears it when it unsets the pick, and takes a gone checkpoint off a good one's list, `at` unchanged.
   */
  private probeCache: { result: ProbeResult; at: number } | null = null
  /** The last probe that finished and what it answered, whether or not the cache took it: `warm`'s clock and the note's last check. */
  private lastProbe: { result: ProbeResult; at: number } | null = null
  /** The checkpoint the last good probe resolved, kept through later failures: what a key names when none is configured (F179). */
  private lastCheckpoint: string | null = null
  private probing: Promise<ProbeResult> | null = null
  /** Probes started so far: the one `startProbe` starts is number `probeSeq` (F179). */
  private probeSeq = 0
  /**
   * Every checkpoint `dropVanished` found gone, each with the number of the last probe started before it was found gone
   * (F179): a probe numbered up to that read the list from before it left, so `startProbe` discards a good answer from
   * one that still picks any of them (a fresh probe follows) and takes all of them off the list of one that only lists
   * them. A map, not one slot: a second drop while a probe runs must not make that probe's answer forget the first.
   */
  private readonly vanished = new Map<string, number>()
  /**
   * The number of the probe that was running when `dropVanished` unset the pick (F179): if that probe fails, a fresh one
   * follows it (`startProbe`; a good answer is used unless it still picks the dropped checkpoint, `vanished`). Never set
   * when the drop only trimmed the cached probe's list.
   */
  private reprobeAfter: number | null = null
  private lastStateLine: string | null = null
  private readonly queue: Job[] = []
  private readonly jobs = new Map<string, Job>()
  private running: Job | null = null
  private pumping = false
  private pumpRun: Promise<void> | null = null
  /** Commits no job makes (the origins of pictures already made), awaited by whenIdle and shutdown. */
  private readonly asideCommits = new Set<Promise<void>>()
  /** submit → history entry of the last picture made, for the note's wait estimate; null until one is. */
  private lastGenMs: number | null = null
  private stopped = false
  private wake: (() => void) | null = null

  constructor(deps: ImageServiceDeps) {
    this.emitFn = deps.emit
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.log(line))
    this.fetchFn = deps.fetchFn ?? fetch
    let config: { ok: true; cfg: ComfyConfig } | { ok: false; reason: string }
    try {
      config = comfyConfig(deps.env ?? process.env)
    } catch (e) {
      this.log(`[imagegen] reading the configuration failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      config = { ok: false, reason: `the image generation settings could not be read (${errText(e)})` }
    }
    this.config = config
    this.client = config.ok ? new ComfyClient(config.cfg.url, this.fetchFn) : null
    this.pollMs = deps.pollMs ?? POLL_MS
    this.timeoutMs = deps.timeoutMs ?? (config.ok ? config.cfg.timeoutMs : 300_000)
    if (config.ok && config.cfg.checkpoint && !config.cfg.workflow.usesCheckpoint) {
      this.log(`[imagegen] LOCALCODE_COMFYUI_CHECKPOINT="${config.cfg.checkpoint}" is ignored: the workflow at ${config.cfg.workflow.source} has no {{checkpoint}}`)
    }
  }

  // ─── probe ──────────────────────────────────────────────────────────

  /** Check the server now (engine start: `void imageService.probe()`). Logs once per state change; never throws. */
  async probe(): Promise<ProbeResult> {
    if (!this.config.ok) {
      this.logState(this.config.reason === UNSET_REASON ? '[imagegen] off: LOCALCODE_COMFYUI_URL unset' : `[imagegen] not ready: ${this.config.reason}`)
      return { ok: false, reason: this.config.reason }
    }
    return this.runProbe(this.config.cfg)
  }

  /**
   * Refresh the pick in the background (F179): the loop calls this at the start of every project-chat turn, and the
   * turn's RenderUI is annotated tens of seconds later, so a key names the checkpoint the server has now — one added or
   * removed since is seen at the next turn that starts 30 s or more after the last probe, not after the 10-minute reuse.
   * Starts a probe unless one is running or the last one finished, whatever it answered, less than 30 s ago
   * (`WARM_MIN_AGE_MS`, measured from `lastProbe`, so a server that keeps failing is not asked at every turn); nothing
   * when the config is refused or the engine is shutting down. Synchronous, never throws; a failed probe logs its own
   * `not ready` line and leaves a good probe still inside its 10 minutes trusted (`runProbe`).
   */
  warm(): void {
    try {
      if (!this.config.ok || this.stopped || this.probing) return
      const last = this.lastProbe
      if (last && this.now() - last.at < WARM_MIN_AGE_MS) return
      this.runProbe(this.config.cfg).catch(e => this.log(`[imagegen] warm-up probe failed: ${errText(e)}`))
    } catch (e) {
      this.log(`[imagegen] warm-up threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    }
  }

  private logState(line: string): void {
    if (line === this.lastStateLine) return
    this.lastStateLine = line
    this.log(line)
  }

  /** The probe running, joined; else a new one. */
  private runProbe(cfg: ComfyConfig): Promise<ProbeResult> {
    return this.probing ?? this.startProbe(cfg)
  }

  /**
   * Probe number `++probeSeq`, which becomes `probing`. A probe numbered up to the one `dropVanished` recorded
   * (`vanished`) started before that checkpoint left and read the server's list from before (F179): a good answer that
   * still picks it is not used — neither `lastCheckpoint` nor the cache — and a fresh probe follows; a good answer that
   * picks another but still lists it is used with that name taken off its list (`withoutCheckpoint`), so a job keyed on
   * it fails before any POST and one keyed on the pick paints. The probe that was running when a drop unset the pick
   * (`reprobeAfter`) is followed by a fresh probe when it fails too, and that failure is not cached. A fresh probe
   * replaces the one it follows as `probing` before that one settles, so whoever waits on it (a job's `ensureReady`,
   * `whenIdle`) gets the fresh answer.
   */
  private startProbe(cfg: ComfyConfig): Promise<ProbeResult> {
    const n = ++this.probeSeq
    const run = (async (): Promise<ProbeResult> => {
      let result: ProbeResult
      try {
        result = await probeComfy(cfg, this.fetchFn)
      } catch (e) {
        this.log(`[imagegen] probe threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
        result = { ok: false, reason: `checking ComfyUI at ${cfg.host} failed: ${errText(e)}` }
      }
      const at = this.now()
      // Every checkpoint found gone after this probe started: it read the server from before they left.
      const goneNames = [...this.vanished].filter(([, seq]) => n <= seq).map(([name]) => name)
      // An answer picking one of them is not used; one that only lists them (the pick another) is used without them —
      // dropping that answer for another probe would let one failed probe fail every picture behind for 60 s (F179).
      const gone = result.ok ? goneNames.find(name => result.ok && result.checkpoint === name) ?? null : null
      const stale = gone !== null
      if (!stale) {
        for (const name of goneNames) {
          const trimmed = withoutCheckpoint(result, name)
          if (trimmed !== result) this.log(`[imagegen] a probe started before ${name} left the server still lists it; used without it`)
          result = trimmed
        }
      }
      this.lastProbe = { result, at }
      // A probe running when a drop unset the pick started before it; only a failed one is followed by a fresh probe.
      const follow = stale || (this.reprobeAfter === n && !result.ok)
      if (this.reprobeAfter === n) this.reprobeAfter = null
      if (stale) {
        this.log(`[imagegen] a probe started before ${gone} left the server still picks it; not used${this.stopped ? '' : ' — probing again'}`)
      } else {
        // A failure never replaces a good probe still inside its 10 minutes (F179): one blip at a turn's warm-up would
        // otherwise fail, with no POST, every job that starts in the next 60 s while the server answers. `ensureReady`
        // starts a probe only once the cache is stale and `dropVanished` only after clearing it, so only a probe `warm`
        // or `probe` starts, or one that follows a stale answer, can meet such a probe.
        const trusted = this.probeCache
        if (!follow && (result.ok || !trusted?.result.ok || at - trusted.at >= PROBE_OK_TTL_MS)) this.probeCache = { result, at }
        if (result.ok && result.checkpoint) this.lastCheckpoint = result.checkpoint
        if (result.ok) {
          const ckpt = result.checkpoint ? `checkpoint ${result.checkpoint} (${result.picked ? `picked from ${result.checkpointCount}` : 'configured'})` : 'checkpoint set by the workflow'
          this.logState(`[imagegen] ready: ComfyUI ${result.version} at ${cfg.host} — ${result.device}, ${result.vramGB ?? '?'} GB; ${ckpt}; ${cfg.width}x${cfg.height}, ${cfg.steps} steps, cfg ${cfg.cfg}, ${cfg.sampler}/${cfg.scheduler}`)
        } else {
          this.logState(`[imagegen] not ready: ${result.reason}`)
        }
      }
      if (follow && !this.stopped) return this.startProbe(cfg)
      return result
    })()
    this.probing = run
    run.finally(() => { if (this.probing === run) this.probing = null }).catch(e => this.log(`[imagegen] probe bookkeeping failed: ${errText(e)}`))
    return run
  }

  /**
   * The cached probe while it is fresh (a failure for 60 s, a success for 10 minutes), else a new one — so a probe
   * started here never meets a trusted success: a failure it returns is the one the cache now holds.
   */
  private ensureReady(cfg: ComfyConfig): Promise<ProbeResult> {
    const c = this.probeCache
    if (c && this.now() - c.at < (c.result.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) return Promise.resolve(c.result)
    return this.runProbe(cfg)
  }

  // ─── annotate ───────────────────────────────────────────────────────

  /**
   * Two kinds of Image get their engine-only state here, in one synchronous
   * step: one with a `prompt` is a picture to paint (`annotatePictures`), one
   * whose src was a path in the project is a file to show (`annotateFiles`).
   * The note for the tool result names the files first, then the pictures.
   */
  annotate(spec: UiSpec, at: AnnotateAt): Annotation {
    const files = this.annotateFiles(spec, at)
    const pictures = this.annotatePictures(spec, at)
    if (files === null) return pictures
    return { note: pictures.note ? `${files} ${pictures.note}` : files, start: pictures.start }
  }

  /**
   * File Images: each gets the file state the page fetches from the file
   * route (a project chat), or off with the reason (anywhere else), whatever
   * ComfyUI is — a file needs no server. The note names a file that is not
   * in the project (a folder, a link out, or simply not written) so the model
   * writes it or describes the picture instead; it says nothing when every
   * file is there. Never throws.
   */
  private annotateFiles(spec: UiSpec, at: AnnotateAt): string | null {
    try {
      const project = at.project
      const files = annotateFileImages(spec, project ? project.slug : null)
      if (files.length === 0) return null
      const count = `${files.length} file${files.length === 1 ? '' : 's'}`
      if (!project) {
        this.log(`[imagegen] RenderUI ${at.toolId} (surface ${at.surfaceId}): ${count} not shown — ${FILES_ONLY_REASON}`)
        return `Files: not shown — ${FILES_ONLY_REASON}.`
      }
      const missing = files.filter(f => !isProjectFile(project.dir, f.path)).map(f => f.path)
      this.log(`[imagegen] RenderUI ${at.toolId} (surface ${at.surfaceId}): ${count} from the project${missing.length ? `, ${missing.length} not found: ${missing.join(', ')}` : ''}`)
      if (missing.length === 0) return null
      return `Files: not in the project — ${missing.join(', ')}; write the file first, or describe the picture in "prompt" and the engine generates it.`
    } catch (e) {
      this.log(`[imagegen] annotating RenderUI ${at.toolId}'s files threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return null
    }
  }

  private annotatePictures(spec: UiSpec, at: AnnotateAt): Annotation {
    try {
      return this.annotateInner(spec, at)
    } catch (e) {
      this.log(`[imagegen] annotating RenderUI ${at.toolId} threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      const reason = `picture generation failed inside the engine (${errText(e)})`
      try {
        for (const im of promptedImages(spec)) im.el.image = { status: 'off', reason }
      } catch (e2) {
        this.log(`[imagegen] marking RenderUI ${at.toolId}'s pictures off failed too: ${errText(e2)}`)
      }
      return { note: notGeneratedNote(reason), start: noop }
    }
  }

  private annotateInner(spec: UiSpec, at: AnnotateAt): Annotation {
    const images = promptedImages(spec)
    if (images.length === 0) return { note: null, start: noop }
    const summary = (q: number, c: number, o: number, reason: string | null) =>
      this.log(`[imagegen] RenderUI ${at.toolId} (surface ${at.surfaceId}): ${images.length} pictures — ${q} queued, ${c} already made${o ? `, ${o} not generated: ${reason}` : ''}`)
    const offAll = (reason: string): Annotation => {
      for (const im of images) im.el.image = { status: 'off', reason }
      summary(0, 0, images.length, reason)
      return { note: notGeneratedNote(reason), start: noop }
    }
    if (!at.project) return offAll(PROJECT_ONLY_REASON)
    if (!this.config.ok) return offAll(this.config.reason)
    if (at.cutOff) return offAll(CUT_OFF_REASON)
    if (this.stopped) return offAll(STOPPING_REASON)
    const cfg = this.config.cfg
    const { dir, slug, chatFile } = at.project
    // A link or special file the model planted where the store goes: nothing is read or written through it.
    const fault = storeFault(dir)
    if (fault) return offAll(fault)

    // Decide every element first; nothing is written or queued until all are decided.
    const decided = new Map<string, UiImageState>()
    const newJobs: Job[] = []
    const origins: Array<[string, string]> = []
    // Queued 'auto' jobs an ask keyed on a pick joins, with that pick (autoTwin): pinned once every element is decided.
    const pins: Array<[Job, string]> = []
    let distinct = 0, overCap = false, queueFull = 0
    let q = 0, c = 0, o = 0, firstOff: string | null = null
    // Distinct pictures, for the note: Images that repeat a prompt and seed are one picture (the log's counts are per Image).
    let qd = 0, cd = 0, dup = 0
    // Jobs this call's pictures wait behind: the queue and a job still in flight (a settled one is committing, not painting).
    const ahead = this.queue.length + (this.running && !this.running.settled ? 1 : 0)
    for (const im of images) {
      const fields = this.keyFields(cfg, im.prompt, im.seed)
      const key = imageKey(fields)
      const repeat = decided.has(key)
      let state = decided.get(key)
      if (!state) {
        const base = { key, slug, w: cfg.width, h: cfg.height }
        if (distinct >= PER_CALL_CAP) { state = { status: 'off', reason: CAP_REASON }; overCap = true }
        else {
          distinct++
          // A settled job still committing is not in flight: its sidecar already says how it ended.
          const job = this.jobs.get(`${dir}|${key}`)
          const inFlight = job && !job.settled ? job : null
          const sc = inFlight ? null : readSidecar(dir, key)
          const made = !!sc && sc.status === 'done' && existsSync(pngPath(dir, key))
          const twin = inFlight || made ? null : this.autoTwin(dir, fields)
          if (inFlight) state = { status: inFlight.status, ...base }
          else if (made) state = { status: 'done', ...base }
          else if (twin) {
            state = { ...base, key: twin.key, status: twin.status }
            if (twin.pin) pins.push([twin.pin, fields.checkpoint])
          } else if (this.queue.length + newJobs.length >= QUEUE_CAP) state = { status: 'off', reason: QUEUE_FULL_REASON }
          else {
            newJobs.push(this.makeJob(cfg, fields, key, im.alt, im.seed === undefined ? 'prompt' : 'model', { dir, slug, chatFile }, { toolId: at.toolId, elementId: im.id, surfaceId: at.surfaceId }))
            state = { status: 'queued', ...base }
          }
        }
        decided.set(key, state)
      }
      im.el.image = { ...state }
      if (state.status === 'off') {
        o++
        firstOff ??= state.reason
        if (state.reason === QUEUE_FULL_REASON) queueFull++
      } else {
        // The key shown, which is an 'auto' twin's when the picture was found under it.
        origins.push([originKey({ chatFile, toolId: at.toolId, elementId: im.id }), 'key' in state ? state.key : key])
        if (repeat) dup++
        if (state.status === 'done') { c++; if (!repeat) cd++ }
        else { q++; if (!repeat) qd++ }
      }
    }

    if (origins.length) {
      const refused = ensureImageIgnore(dir)
      if (refused) return offAll(refused)
      mkdirSync(imagesDir(dir), { recursive: true })
      for (const j of newJobs) writeSidecar(dir, j.sidecar)
      recordOrigins(dir, origins)
    }
    for (const j of newJobs) { this.queue.push(j); this.jobs.set(j.id, j) }
    for (const [j, ckpt] of pins) { j.sidecar.checkpoint = ckpt; j.pinned = ckpt }
    summary(q, c, o, firstOff)
    // Every picture already made: no job of this call will commit the origins just recorded.
    if (origins.length && q === 0) this.commitAside(dir, `images: ${c} shown again`)

    const parts: string[] = []
    if (qd > 0) {
      // The server's address is the engine log's, never the model's: the prompt says never to call it, and the fence refuses a command at it.
      let s = `Pictures: ${qd} generating${cd ? `, ${cd} already made` : ''} — they appear in their cards by themselves; do not call RenderUI again for them.`
      // More than three is minutes of GPU (three designs × six takes ≈ 3 min at ~10 s a picture, measured 2026-10-13, F176): say how long, so the wait is not read as a failure.
      if (qd > 3) {
        if (this.lastGenMs === null) s += ' The first takes longer while the model loads.'
        else s += ` About ${newJobs.length + ahead}×${Math.max(1, Math.round(this.lastGenMs / 1000))} s at the last measured pace${ahead ? ` (${ahead} ahead in the queue)` : ''}.`
      }
      // The last check, even one that left a trusted good probe in place: the server may be away.
      const last = this.lastProbe?.result
      if (last && !last.ok) s += ` The last check of ComfyUI failed (${last.reason}); if it still fails, the cards will say so.`
      parts.push(s)
    } else if (cd > 0) parts.push(`Pictures: ${cd} already made — shown in their cards.`)
    else parts.push(notGeneratedNote(firstOff ?? CAP_REASON))
    // Four takes asked with no seeds are one picture four times: say so, or the cards fill with one picture after "4 generating".
    if (dup) parts.push(`${dup} Image${dup === 1 ? ' repeats' : 's repeat'} the prompt and seed of another — give each take its own "seed" for another picture.`)
    if (overCap) parts.push(`Only the first ${PER_CALL_CAP} pictures in a surface are generated.`)
    if (queueFull && (q > 0 || c > 0)) parts.push(`${queueFull} not generated — ${QUEUE_FULL_REASON}.`)

    let started = false
    return {
      note: parts.join(' '),
      start: () => {
        if (started) return
        started = true
        if (this.queue.length) this.kick()
      },
    }
  }

  /**
   * The seed is the model's when the Image gave one (another take, F176), else derived from the prompt (one prompt, one picture).
   * The checkpoint is the one that will paint (F179): the configured one, else the last good probe's pick, else 'auto' before
   * any probe has picked. Annotate asks the server nothing: the pick is the one known now, kept current by `warm` at each
   * project-chat turn (at most every 30 s), by a job's probe, and by `dropVanished`, which unsets it when the checkpoint
   * found gone is the pick and starts a probe at once — or, with one running, takes that one's answer, a fresh probe
   * following it only when it fails or still picks the gone checkpoint; `runJob` paints with the one the key names.
   */
  private keyFields(cfg: ComfyConfig, prompt: string, seed?: number): KeyFields {
    return {
      prompt, negative: cfg.negative, seed: seed ?? seedFor(prompt, cfg.negative), width: cfg.width, height: cfg.height,
      steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler,
      checkpoint: cfg.checkpoint ?? (cfg.workflow.usesCheckpoint ? this.lastCheckpoint : null) ?? 'auto', workflow: cfg.workflow.sha256,
    }
  }

  /**
   * The same picture under the key it was asked with before any probe had picked (F179): the `'auto'` key of `f`,
   * when its job will paint, is painting, or painted with the checkpoint `f` names — so a picture asked before the
   * first probe, or made before F179, is shown again instead of painted again. A queued `'auto'` job has taken no
   * pick yet: joining it pins it to `f`'s checkpoint (`pin`, applied by annotate once every element is decided), so
   * it paints that one whatever its own probe picks — unless that checkpoint is found gone first (its probe's list
   * lacks it, or ComfyUI refuses it), which unpins it. A running or finished one from another checkpoint is not the
   * same picture and never counts. Null when a checkpoint is configured (its keys always named it).
   */
  private autoTwin(dir: string, f: KeyFields): { key: string; status: 'queued' | 'running' | 'done'; pin: Job | null } | null {
    if (!this.config.ok || this.config.cfg.checkpoint || f.checkpoint === 'auto') return null
    const key = imageKey({ ...f, checkpoint: 'auto' })
    const job = this.jobs.get(`${dir}|${key}`)
    if (job && !job.settled) {
      // A running job has its checkpoint on the record; a queued one still saying 'auto' paints what this join pins.
      const pin = job.status === 'queued' && job.sidecar.checkpoint === 'auto'
      return pin || job.sidecar.checkpoint === f.checkpoint ? { key, status: job.status, pin: pin ? job : null } : null
    }
    const sc = readSidecar(dir, key)
    return sc && sc.status === 'done' && sc.checkpoint === f.checkpoint && existsSync(pngPath(dir, key)) ? { key, status: 'done', pin: null } : null
  }

  private makeJob(cfg: ComfyConfig, f: KeyFields, key: string, alt: string, seedFrom: 'model' | 'prompt', p: { dir: string; slug: string; chatFile: string }, o: { toolId: string; elementId: string; surfaceId: string }): Job {
    const queuedAt = this.now()
    const sidecar: ImageSidecar = {
      schema: 1, key, status: 'queued', runId: RUN_ID,
      prompt: f.prompt, negative: f.negative, alt, seed: f.seed, seedFrom, width: f.width, height: f.height, steps: f.steps, cfg: f.cfg,
      sampler: f.sampler, scheduler: f.scheduler, checkpoint: f.checkpoint,
      workflow: { source: cfg.workflow.source, sha256: cfg.workflow.sha256 },
      apiPrompt: null,
      comfy: { host: cfg.host, promptId: randomUUID(), outputs: [] },
      queuedAt: iso(queuedAt),
      origin: { chatFile: p.chatFile, ...o },
    }
    return { id: `${p.dir}|${key}`, dir: p.dir, slug: p.slug, key, sidecar, queuedAt, status: 'queued', pinned: null, onServer: null, settled: false }
  }

  // ─── worker ─────────────────────────────────────────────────────────

  private kick(): void {
    if (!this.pumping && !this.stopped) this.pumpRun = this.pump()
  }

  /** Resolves once the worker has nothing left to do, commits and a probe still running (a `warm`'s) included (tests, check.ts). */
  async whenIdle(): Promise<void> {
    while (this.pumpRun || this.asideCommits.size || this.probing) {
      const run = this.pumpRun
      if (!run) { await Promise.all([...this.asideCommits, this.probing?.then(noop, noop)]); continue }
      await run
      if (this.pumpRun === run) this.pumpRun = null
    }
  }

  /** FIFO, at most one job in flight across the engine. */
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return
    this.pumping = true
    try {
      while (!this.stopped) {
        const job = this.queue.shift()
        if (!job) break
        this.running = job
        try {
          await this.runJob(job)
        } catch (e) {
          this.log(`[imagegen] ${job.key.slice(0, 8)}: the worker threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
          if (!this.stopped) {
            // A throw after the POST must not leave our prompt on the server beside the next job's.
            const held = job.onServer ? await job.onServer : null
            if (held && this.client && !this.stopped) await this.withdraw(this.client, job, held)
            await this.finish(job, { status: 'failed', reason: reasonOf(e) })
          }
        } finally {
          this.running = null
          // A re-request after a failure may already hold this id with a new job.
          if (!this.stopped && this.jobs.get(job.id) === job) this.jobs.delete(job.id)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async runJob(job: Job): Promise<void> {
    if (!this.config.ok || !this.client) return this.finish(job, { status: 'failed', reason: this.config.ok ? 'no ComfyUI client' : this.config.reason })
    const cfg = this.config.cfg, client = this.client, sc = job.sidecar
    const ready = await this.ensureReady(cfg)
    if (this.stopped) return
    if (!ready.ok) return this.finish(job, { status: 'failed', reason: ready.reason })
    // Minutes may have passed since annotate: a link planted since fails the job before anything is written.
    const fault = storeFault(job.dir)
    if (fault) return this.finish(job, { status: 'failed', reason: fault })

    // The key names the checkpoint that paints (F179), so a key and its picture always agree: only a job still saying
    // 'auto' (asked before any probe, and pinned by no join, or unpinned since) takes the probe's pick. The probe's list
    // is the first check that the checkpoint is still on the server: a pin it no longer holds is let go (the key says
    // 'auto', so the job paints on the pick), and a key's checkpoint it no longer holds fails the job here, before any
    // POST, with our own reason. Either drops that checkpoint (`dropVanished`). ComfyUI's 400 refusing it
    // (`'<name>' not in`) is the check for a list read before it left, and drops it the same way.
    const listed = cfg.workflow.usesCheckpoint && !cfg.checkpoint ? ready.checkpoints : undefined
    if (listed && job.pinned !== null && !listed.includes(job.pinned)) {
      const gone = job.pinned
      job.pinned = null
      sc.checkpoint = 'auto'
      this.log(`[imagegen] ${job.key.slice(0, 8)}: ComfyUI no longer lists ${gone}, which an ask pinned this 'auto' picture to; it paints on the probe's pick, ${ready.checkpoint}`)
      this.dropVanished(job.key, gone)
    }
    if (listed && sc.checkpoint !== 'auto' && !listed.includes(sc.checkpoint)) {
      const gone = sc.checkpoint
      this.dropVanished(job.key, gone)
      // What the same ask keys on now (`keyFields`); none when the drop unset the pick.
      const pick = this.lastCheckpoint
      return this.finish(job, { status: 'failed', reason: `the checkpoint ${gone} this picture was keyed on is no longer on the image server${pick ? ` — ask again and it is painted on ${pick}` : ''}` })
    }
    const keyed = sc.checkpoint === 'auto' ? null : sc.checkpoint
    if (keyed && cfg.workflow.usesCheckpoint && ready.checkpoint && ready.checkpoint !== keyed) {
      this.log(`[imagegen] ${job.key.slice(0, 8)}: painting with ${keyed}, the pick when it was asked (the probe now picks ${ready.checkpoint})`)
    }
    const ckpt = keyed ?? ready.checkpoint ?? ''
    const graph = fillWorkflow(cfg.workflow.graph, {
      prompt: sc.prompt, negative: sc.negative, seed: sc.seed, width: sc.width, height: sc.height, steps: sc.steps, cfg: sc.cfg,
      sampler: sc.sampler, scheduler: sc.scheduler, checkpoint: ckpt, filename_prefix: `cynco/${job.key}`,
    })
    sc.status = 'running'
    sc.startedAt = iso(this.now())
    if (!keyed && ready.checkpoint) sc.checkpoint = ready.checkpoint
    sc.apiPrompt = graph
    sc.comfy = { ...sc.comfy, host: client.host }
    job.status = 'running'
    // Before the POST: a crash from here on leaves a record naming the prompt id.
    writeSidecar(job.dir, sc)
    const sent = sc.comfy.promptId
    const submission = client.submit(graph, sent)
    job.onServer = submission.then(id => id, e => (e instanceof ComfyError && e.refused ? null : sent))
    let id: string
    try {
      id = await submission
    } catch (e) {
      this.log(`[imagegen] ${job.key.slice(0, 8)}: submit failed: ${reasonOf(e)}`)
      if (this.stopped) return
      if (e instanceof ComfyError && e.refused) {
        // ComfyUI queued nothing. A refusal of the checkpoint painted with says it has left the server: its
        // value_not_in_list detail, `<input>: '<name>' not in [...]` (or `(list of length N)`), puts the refused value,
        // quoted, before `not in`, so only that form counts — a refusal of another loader whose list merely names it does not.
        if (cfg.workflow.usesCheckpoint && !cfg.checkpoint && ckpt && e.reason.includes(`'${ckpt}' not in`)) this.dropVanished(job.key, ckpt)
      } else {
        // The POST may have been queued with its answer lost: withdraw it before the next job goes out.
        await this.withdraw(client, job, sent)
      }
      return this.finish(job, { status: 'failed', reason: reasonOf(e) })
    }
    const submitAt = this.now()
    sc.queueMs = submitAt - job.queuedAt
    if (id !== sc.comfy.promptId) { sc.comfy.promptId = id; writeSidecar(job.dir, sc) }
    if (this.stopped) return
    this.emit({ type: 'ui.image', key: job.key, slug: job.slug, status: 'running' })

    let entry: HistoryEntry | null = null
    for (let misses = 0; !entry;) {
      try {
        entry = await client.history(id)
        misses = 0
      } catch (e) {
        misses++
        this.log(`[imagegen] ${job.key.slice(0, 8)}: history poll failed (${misses} of ${POLL_FAILURES_TOLERATED}): ${reasonOf(e)}`)
        if (misses >= POLL_FAILURES_TOLERATED && !this.stopped) {
          // Our prompt may still be queued or running there: the next job must not make it two.
          await this.withdraw(client, job, id)
          return this.finish(job, { status: 'failed', reason: reasonOf(e) })
        }
      }
      if (this.stopped) return
      if (entry) break
      if (this.now() - submitAt >= this.timeoutMs) {
        await this.withdraw(client, job, id)
        return this.finish(job, { status: 'failed', reason: `ComfyUI did not finish within ${Math.round(this.timeoutMs / 1000)} s (it may be busy with other work)` })
      }
      await this.sleep(this.pollMs)
      if (this.stopped) return
    }
    // The prompt has ended on the server: nothing of ours is left there to stop.
    job.onServer = null
    sc.genMs = this.now() - submitAt
    const exec = execMsOf(entry)
    if (exec !== null) sc.execMs = exec

    const failure = historyFailure(entry)
    if (failure) return this.finish(job, { status: 'failed', reason: failure })
    const refs = outputRefs(entry.outputs)
    if (refs.length === 0) return this.finish(job, { status: 'failed', reason: 'the workflow saved no image (add a SaveImage node)' })
    sc.comfy = { ...sc.comfy, outputs: refs }
    let bytes: Uint8Array
    try {
      bytes = await client.download(refs[0], DOWNLOAD_CAP_BYTES)
    } catch (e) {
      this.log(`[imagegen] ${job.key.slice(0, 8)}: download failed: ${reasonOf(e)}`)
      if (this.stopped) return
      return this.finish(job, { status: 'failed', reason: reasonOf(e) })
    }
    if (this.stopped) return
    const late = storeFault(job.dir)
    if (late) return this.finish(job, { status: 'failed', reason: late })
    // The local name comes from the key alone; the server's filename was only ever a query parameter.
    const part = partPath(job.dir, job.key)
    try {
      mkdirSync(dirname(part), { recursive: true })
      // A link planted at the .part name is removed, never followed: 'wx' creates a new file or fails.
      rmSync(part, { force: true })
      writeFileSync(part, bytes, { flag: 'wx' })
      renameSync(part, pngPath(job.dir, job.key))
    } catch (e) {
      this.log(`[imagegen] ${job.key.slice(0, 8)}: writing the picture into ${job.dir} failed: ${errText(e)}`)
      return this.finish(job, { status: 'failed', reason: `the picture could not be written into the project (${errText(e)})` })
    }
    sc.sha256 = sha256Of(bytes)
    sc.bytes = bytes.byteLength
    await this.finish(job, { status: 'done' })
  }

  /**
   * Checkpoint `ckpt` has left the server (F179): the probe a job trusts no longer lists it, or ComfyUI refused a job's
   * POST naming it (both found in `runJob`). The drop is always recorded with the number of the last probe started
   * (`vanished`): a probe started before it read the list from before, so when it finishes `startProbe` discards a good
   * answer that still picks `ckpt` (a fresh probe follows) and takes `ckpt` off the list of one that only lists it.
   * Every queued job pinned to it goes back to `'auto'` and paints what its own probe at job start picks.
   * While `ckpt` is still the pick, the pick is dropped — `lastCheckpoint` and the cached probe: until a probe answers
   * with a pick, a picture asked is keyed `'auto'`, and one painted on the checkpoint under its `'auto'` key still reads
   * as made; once one picks another, that picture keys on it and is painted again. A probe then starts at once; one
   * already running is joined instead, its answer judged by `startProbe` as above, and a fresh probe follows it too
   * when it fails (`reprobeAfter`).
   * A pick that already names another checkpoint (a probe since) is kept, and so is a cached good probe whose list still
   * names `ckpt` (read before it left): `ckpt` is only taken off that list, its `at` unchanged, so a job keyed on `ckpt`
   * fails in `runJob` before any POST while one keyed on the pick still paints, and no probe is started — dropping that
   * probe and probing again let one failed probe fail every picture behind for 60 s. With no pick to drop, no pin to undo
   * and no cached list naming `ckpt`, nothing else is done and nothing is logged.
   */
  private dropVanished(key: string, ckpt: string): void {
    this.vanished.set(ckpt, this.probeSeq)
    let unpinned = 0
    for (const j of this.queue) {
      if (j.pinned !== ckpt) continue
      j.pinned = null
      j.sidecar.checkpoint = 'auto'
      unpinned++
    }
    const drop = this.lastCheckpoint === ckpt
    // The cached good probe's list still names it (the pick already another): that list was read before it left.
    const cached = this.probeCache
    const trimmed = cached && !drop ? { result: withoutCheckpoint(cached.result, ckpt), at: cached.at } : null
    const staleList = !!trimmed && trimmed.result !== cached?.result
    if (!drop && !staleList && unpinned === 0) return
    const pins = unpinned ? `; ${unpinned} queued picture${unpinned === 1 ? '' : 's'} pinned to it ${unpinned === 1 ? 'goes' : 'go'} back to 'auto' and ${unpinned === 1 ? "paints on the pick its job's probe makes" : "paint on the picks their jobs' probes make"}` : ''
    if (drop) {
      this.lastCheckpoint = null
      this.probeCache = null
    } else if (staleList) {
      this.probeCache = trimmed
    }
    const pick = this.lastCheckpoint
    const what = drop ? "; probing again for the pick (until it answers, a picture asked is keyed 'auto')" : staleList ? `; the trusted probe still listed it — taken off that list${pick ? ` (the pick stays ${pick})` : ''}` : ''
    this.log(`[imagegen] ${key.slice(0, 8)}: ComfyUI no longer has ${ckpt}${what}${pins}`)
    if (drop && this.config.ok && !this.stopped) {
      // A probe running now may have read the list before the checkpoint left: `startProbe` judges its answer, and a
      // fresh probe follows it too if it fails.
      if (this.probing) this.reprobeAfter = this.probeSeq
      else this.startProbe(this.config.cfg).catch(e => this.log(`[imagegen] the probe after dropping ${ckpt} failed: ${errText(e)}`))
    }
  }

  /** The worker gives up on a prompt ComfyUI may hold: it is the worker's to cancel now, not shutdown's. */
  private async withdraw(client: ComfyClient, job: Job, id: string): Promise<void> {
    job.onServer = null
    await this.cancelOnServer(client, id)
  }

  /** Interrupt and dequeue one prompt by id. Each half is logged and never throws. */
  private async cancelOnServer(client: ComfyClient, id: string): Promise<void> {
    try {
      await client.interrupt(id)
    } catch (e) {
      this.log(`[imagegen] interrupting ${id} failed: ${reasonOf(e)}`)
    }
    try {
      await client.dequeue([id])
    } catch (e) {
      this.log(`[imagegen] dequeueing ${id} failed: ${reasonOf(e)}`)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => { this.wake = null; resolve() }, ms)
      this.wake = () => { clearTimeout(t); this.wake = null; resolve() }
    })
  }

  private emit(e: UiImageEvent): void {
    try {
      this.emitFn(e)
    } catch (err) {
      this.log(`[imagegen] emitting ui.image ${e.status} for ${e.key.slice(0, 8)} failed: ${errText(err)}`)
    }
  }

  /**
   * Write a job's outcome — sidecar, journal line, `ui.image` event, log
   * line — in one synchronous step, so no annotate can run between the
   * record and the event (a re-request of a failed picture must never be
   * followed by the old failure). Returns the commit message for the caller
   * to commit; null when the job was already settled.
   */
  private record(job: Job, outcome: Outcome): string | null {
    if (job.settled) return null
    job.settled = true
    const sc = job.sidecar, key8 = job.key.slice(0, 8), end = this.now()
    const label = sc.alt || sc.prompt.slice(0, 60)
    sc.status = outcome.status
    if (outcome.status === 'failed') sc.reason = outcome.reason
    else delete sc.reason
    sc.finishedAt = iso(end)
    try {
      writeSidecar(job.dir, sc)
      if (outcome.status === 'done') appendJournal(job.dir, 'image.generated', `${label} (${key8}) — ${sc.width}x${sc.height}, ${sc.checkpoint}`)
      else appendJournal(job.dir, 'image.failed', `${label} (${key8}): ${outcome.reason}`)
    } catch (e) {
      this.log(`[imagegen] ${key8}: recording the outcome in ${job.dir} failed: ${errText(e)}`)
    }
    this.emit(outcome.status === 'done'
      ? { type: 'ui.image', key: job.key, slug: job.slug, status: 'done' }
      : { type: 'ui.image', key: job.key, slug: job.slug, status: 'failed', reason: outcome.reason })
    const total = secs(end - job.queuedAt), queue = secs(sc.queueMs ?? end - job.queuedAt)
    if (outcome.status === 'done') {
      if (sc.genMs !== undefined) this.lastGenMs = sc.genMs
      const exec = sc.execMs !== undefined ? `, exec ${secs(sc.execMs)}s` : ''
      const mb = ((sc.bytes ?? 0) / (1024 * 1024)).toFixed(1)
      this.log(`[imagegen] ${key8} done in ${total}s (queue ${queue}s, gen ${secs(sc.genMs ?? 0)}s${exec}) ${sc.width}x${sc.height} ${sc.steps} steps ${sc.checkpoint} on ${sc.comfy.host} → images/${job.key}.png (${mb} MB)`)
    } else {
      this.log(`[imagegen] ${key8} failed after ${total}s (queue ${queue}s): ${outcome.reason}`)
    }
    return outcome.status === 'done' ? `image: ${label} (${key8})` : `image failed: ${label} (${key8})`
  }

  /** Record (the page hears it with the PNG and sidecar already on disk), then commit. */
  private async finish(job: Job, outcome: Outcome): Promise<void> {
    const message = this.record(job, outcome)
    if (message !== null) await this.commit(job.dir, [job.key], message)
  }

  /**
   * Commit the sidecars, the origin index, .gitignore and (unless `journal`
   * is false: nothing was journaled) the journal — never a PNG (ignored, so
   * naming one fails `git add`).
   */
  private async commit(dir: string, keys: string[], message: string, journal = true): Promise<void> {
    try {
      await ensureHistory(dir)
      const paths = ['.gitignore', ...keys.map(k => `images/${k}.json`), 'images/index.json', ...(journal ? ['journal.md'] : [])].filter(p => existsSync(join(dir, p)))
      const r = await commitHistory(dir, paths, message)
      if (!r.ok) this.log(`[imagegen] history commit in ${dir} failed: ${r.reason}`)
    } catch (e) {
      this.log(`[imagegen] history commit in ${dir} threw: ${errText(e)}`)
    }
  }

  /** The origins (and .gitignore) of a call that queued nothing, committed beside the turn; `commit` never rejects. */
  private commitAside(dir: string, message: string): void {
    const run = this.commit(dir, [], message, false).finally(() => { this.asideCommits.delete(run) })
    this.asideCommits.add(run)
  }

  // ─── shutdown ───────────────────────────────────────────────────────

  /**
   * Engine exit: interrupt and dequeue the job in flight (by its prompt_id
   * only — never a global interrupt — and only while ComfyUI may still hold
   * it), mark it and every queued job failed, and commit. A POST still in
   * flight is waited for, so the cancel names the id the server answered with
   * and arrives after the prompt is queued. Bounded to 3 s; the sidecars are
   * marked before any network or git call, so the bound never costs a record.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.wake?.()
    const running = this.running
    // Taken before the jobs are recorded (that settles them): a job that already
    // finished, was refused or was withdrawn has nothing on the server to cancel.
    const onServer = running && !running.settled ? running.onServer : null
    const jobs = [...(running ? [running] : []), ...this.queue.splice(0)]
    const aside = [...this.asideCommits]
    if (jobs.length === 0 && aside.length === 0) return
    const outcome: Outcome = { status: 'failed', reason: STOPPED_REASON }
    const byDir = new Map<string, string[]>()
    for (const j of jobs) {
      if (this.record(j, outcome) === null) continue
      byDir.set(j.dir, [...(byDir.get(j.dir) ?? []), j.key])
    }
    const cancel = async () => {
      const id = onServer ? await onServer : null
      if (id && this.client) await this.cancelOnServer(this.client, id)
    }
    const commits = async () => {
      for (const [dir, keys] of byDir) await this.commit(dir, keys, `images: ${keys.length} stopped with the engine`)
    }
    // Side by side: a slow POST or a hung /interrupt must not hold the commits past the bound.
    const work = Promise.all([cancel(), commits(), ...aside])
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>(resolve => { timer = setTimeout(() => { this.log('[imagegen] shutdown passed its 3 s bound; leaving the rest'); resolve() }, SHUTDOWN_BOUND_MS) })
    await Promise.race([work.catch(e => this.log(`[imagegen] shutdown work threw: ${errText(e)}`)), bound])
    clearTimeout(timer)
  }
}
