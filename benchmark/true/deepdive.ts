/**
 * Deep-dive causal probe for ONE task (default: city-yield-consumers, the task
 * where the headline run showed governance's biggest win, +33).
 *
 * The headline harness (run.ts) throws away everything except a score: it uses a
 * silent emitter, discards the transcript, and only reports passed/total. That is
 * why its results "don't tell you anything" — you can't see WHAT each arm did.
 *
 * This probe keeps the evidence. For every run (governed and ungoverned, N reps
 * each) it captures:
 *   - which of the task's independent test_* assertions passed (per-link verdict),
 *   - the real git diff the agent produced (the actual code it wrote),
 *   - a compact transcript (tool sequence + reasoning, thinking sizes),
 *   - every governance event the loop emitted (the "why" for the governed arm),
 *   - turns and whether it hit the safety timeout.
 *
 * Timeout: there is NO 15-min task cap here. A large safety cap (default 45 min)
 * only exists to stop a genuine infinite loop from wedging the GPU overnight; for
 * normal completion it is effectively "no timer", which removes the timeout
 * confound that muddied the headline run.
 *
 * Writes a single JSON with all per-run evidence to results/deepdive-<task>-<ts>.json.
 * Not part of the headline harness or the vitest suite — it is an analysis
 * instrument that reuses the harness's tested primitives.
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../engine/config.js'
import { bootstrapProvider } from '../../engine/bootstrapProvider.js'
import type { Message } from '../../engine/types.js'
import { ConversationLoop } from '../../engine/bridge/conversationLoop.js'
import { S5Orchestrator } from '../../engine/s5/orchestrator.js'
import { RuleBasedS5 } from '../../engine/s5/ruleBasedS5.js'
import { loadCivkingsTasks } from './harness/tasks.js'
import { cloneRepo, checkoutRef, applyPatch, removeWorkdir } from './harness/isolate.js'
import { withAblationEnv } from './harness/ablationEnv.js'
import { countTurns } from './harness/driver.js'
import type { TaskDef } from './harness/types.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

type Arm = 'governed' | 'ungoverned'

interface PerTestVerdict {
  score: number
  passed: number
  total: number
  results: Record<string, 'PASSED' | 'FAILED'>
  hung: boolean
  raw: string
}

/**
 * Run the hidden test with `-v` so each independent test_* prints its own
 * PASSED/FAILED verdict — the per-link causal detail the headline scorer (-q)
 * does not expose. Same hang/infra semantics as scorer.ts: an ETIMEDOUT means the
 * agent's code hangs → score 0; a genuine spawn error still throws.
 */
function scoreVerbose(
  workdir: string,
  hiddenTestPath: string,
  hiddenTestName: string,
  timeoutMs: number,
): PerTestVerdict {
  const dest = join(workdir, hiddenTestName)
  copyFileSync(hiddenTestPath, dest)
  try {
    const res = spawnSync('python', ['-m', 'pytest', hiddenTestName, '-v'], {
      cwd: workdir,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
      encoding: 'utf-8',
      timeout: timeoutMs,
    })
    if (res.error) {
      if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return { score: 0, passed: 0, total: 0, results: {}, hung: true, raw: `pytest hung >${timeoutMs}ms` }
      }
      throw res.error
    }
    const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`
    const results: Record<string, 'PASSED' | 'FAILED'> = {}
    const re = /::(test_\w+)\s+(PASSED|FAILED)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) results[m[1]] = m[2] as 'PASSED' | 'FAILED'
    const names = Object.keys(results)
    const passed = names.filter((n) => results[n] === 'PASSED').length
    const total = names.length
    return { score: total > 0 ? passed / total : 0, passed, total, results, hung: false, raw }
  } finally {
    rmSync(dest, { force: true })
  }
}

/** Compact one message: keep tool sequence + short reasoning, drop bulk. */
function compactMessage(m: Message) {
  const text: string[] = []
  let thinkingChars = 0
  const tools: { name: string; target?: unknown }[] = []
  let resultErrors = 0
  for (const b of m.content) {
    if (b.type === 'text') text.push(b.text)
    else if (b.type === 'thinking') thinkingChars += b.text.length
    else if (b.type === 'tool_use') {
      const inp = b.input as Record<string, unknown>
      tools.push({ name: b.name, target: inp?.file_path ?? inp?.path ?? inp?.command ?? inp?.pattern })
    } else if (b.type === 'tool_result' && b.is_error) resultErrors++
  }
  return { role: m.role, text: text.join('\n').slice(0, 1500), thinkingChars, tools, resultErrors }
}

interface RunRecord {
  arm: Arm
  rep: number
  score: number
  passed: number
  total: number
  perTest: Record<string, 'PASSED' | 'FAILED'>
  hung: boolean
  timedOut: boolean
  turns: number
  toolHistogram: Record<string, number>
  governanceEvents: Array<{ type: string; severity?: string; message?: string; source?: string }>
  notableEvents: Array<{ type: string; message?: string }>
  signalTimeline: SignalSnapshot[]
  eventTypeCounts: Record<string, number>
  diff: string
  untracked: string
  transcript: ReturnType<typeof compactMessage>[]
}

/**
 * One per-turn snapshot of the governance control state. governance.status fires
 * once per completed turn (onTurnComplete); we stamp it with the most recent
 * control.signals (temperature/variety) and s5.decision (tool restriction) seen
 * since the last status, so each row shows the FULL set of gated levers active on
 * that turn. This is what lets us correlate "which lever fired" with "did it pass".
 */
interface SignalSnapshot {
  turn: number
  health?: string
  stuckTurns?: number
  toolSuccessRate?: number
  varietyRatio?: number
  varietyBalance?: number
  algedonicAlerts?: number
  consecutiveUnstable?: number
  temperature?: number
  temperatureAdjust?: number
  widenToolSet?: boolean
  bestOfNBudget?: number
  toolRestriction?: unknown
  contextAction?: unknown
}

// Event types that signal an actual intervention firing (nudge injected, tools
// gated, contract/reflexion/algedonic action). We match loosely on the type/
// message so we catch them regardless of exact event-name spelling.
const NOTABLE_RE = /nudge|inject|contract|reflexion|algedonic|stuck|interven|redirect|restrict|halt|synthetic/i

async function runOnce(
  task: TaskDef,
  arm: Arm,
  rep: number,
  config: any,
  provider: any,
  civkingsRepo: string,
  timeoutMs: number,
): Promise<RunRecord> {
  const work = mkdtempSync(join(tmpdir(), `deepdive-${task.id}-`))
  try {
    cloneRepo(civkingsRepo, work)
    checkoutRef(work, task.startRef)
    if (task.setupPatch) applyPatch(work, task.setupPatch)

    const governanceEvents: RunRecord['governanceEvents'] = []
    const notableEvents: RunRecord['notableEvents'] = []
    const signalTimeline: SignalSnapshot[] = []
    const eventTypeCounts: Record<string, number> = {}
    const toolHistogram: Record<string, number> = {}
    // Carry the most-recent control levers forward so each per-turn status row is
    // stamped with the temperature/tool-restriction active when that turn ran.
    let pendingSignals: Partial<SignalSnapshot> = {}
    let pendingDecision: Partial<SignalSnapshot> = {}
    const emit = (e: any) => {
      const t = e?.type ?? 'unknown'
      eventTypeCounts[t] = (eventTypeCounts[t] ?? 0) + 1
      if (t === 'stream.token') return
      if (t === 'tool.start') {
        const name = e.name ?? e.tool ?? 'unknown'
        toolHistogram[name] = (toolHistogram[name] ?? 0) + 1
        return
      }
      if (t === 'control.signals') {
        pendingSignals = {
          temperature: e.temperature, temperatureAdjust: e.temperatureAdjust,
          bestOfNBudget: e.bestOfNBudget, widenToolSet: e.widenToolSet,
        }
        return
      }
      if (t === 's5.decision') {
        pendingDecision = { toolRestriction: e.toolRestriction, contextAction: e.contextAction }
        return
      }
      if (t === 'governance.status') {
        signalTimeline.push({
          turn: signalTimeline.length + 1,
          health: e.health, stuckTurns: e.stuckTurns, toolSuccessRate: e.toolSuccessRate,
          varietyRatio: e.varietyRatio, varietyBalance: e.varietyBalance,
          algedonicAlerts: e.algedonicAlerts, consecutiveUnstable: e.consecutiveUnstable,
          ...pendingSignals, ...pendingDecision,
        })
        return
      }
      if (typeof t === 'string' && t.startsWith('governance')) {
        governanceEvents.push({ type: t, severity: e.severity, message: e.message, source: e.source })
      }
      // Capture any event that looks like an intervention actually firing, so we
      // can see WHICH lever moved (not just the steady-state status).
      const msg = typeof e?.message === 'string' ? e.message : ''
      if (NOTABLE_RE.test(t) || NOTABLE_RE.test(msg)) {
        notableEvents.push({ type: t, message: msg.slice(0, 300) })
      }
    }

    console.log(`[deepdive] ${task.id} ${arm} rep ${rep} ...`)
    const started = Date.now()
    const { messages, timedOut } = await withAblationEnv(arm === 'governed', async () => {
      const s5 = new S5Orchestrator(new RuleBasedS5())
      const loop = new ConversationLoop({
        config: { ...config, approveAll: true, noScouts: true },
        provider,
        emit,
        cwd: work,
        s5,
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; loop.abort() }, timeoutMs)
      try {
        await loop.handleUserMessage(task.prompt)
      } finally {
        clearTimeout(timer)
      }
      return { messages: loop.getMessages(), timedOut }
    })
    const elapsedMin = ((Date.now() - started) / 60000).toFixed(1)

    const verdict = scoreVerbose(work, task.hiddenTestPath, task.hiddenTestName, timeoutMs)
    let diff = ''
    let untracked = ''
    try {
      // Diff against the green ref, NOT the working tree: the engine's snapshot
      // layer commits intermediate state, so `git diff` (working-tree vs HEAD) is
      // empty even though the agent changed files. `git diff <startRef>` captures
      // the net change vs green regardless of any intermediate commits/snapshots.
      diff = execFileSync('git', ['-C', work, 'diff', task.startRef], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
      untracked = execFileSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf-8' })
    } catch (err) {
      diff = `<git diff failed: ${err instanceof Error ? err.message : err}>`
    }

    console.log(
      `[deepdive]   -> ${arm} rep ${rep}: score ${(verdict.score * 100).toFixed(0)}% ` +
      `(${verdict.passed}/${verdict.total})  turns ${countTurns(messages)}  ` +
      `${timedOut ? 'TIMED-OUT ' : ''}${verdict.hung ? 'HUNG ' : ''}${elapsedMin}min  ` +
      `gov-events ${governanceEvents.length}`,
    )

    return {
      arm, rep,
      score: verdict.score, passed: verdict.passed, total: verdict.total,
      perTest: verdict.results, hung: verdict.hung,
      timedOut, turns: countTurns(messages),
      toolHistogram, governanceEvents, notableEvents, signalTimeline, eventTypeCounts,
      diff, untracked,
      transcript: messages.map(compactMessage),
    }
  } finally {
    removeWorkdir(work)
  }
}

async function main() {
  const civkingsRepo = arg('--civkings', 'C:\\Users\\civer\\civkings')
  const tasksDir = arg('--tasks', join(import.meta.dirname, 'tasks', 'civkings-b'))
  const taskId = arg('--task', 'city-yield-consumers')
  const reps = parseInt(arg('--reps', '4'), 10)
  const timeoutMs = Math.round(parseFloat(arg('--timeout-min', '45')) * 60_000)
  if (!Number.isInteger(reps) || reps < 1) {
    console.error(`[deepdive] invalid --reps: ${arg('--reps', '4')}`)
    process.exit(1)
  }

  const config = loadConfig()
  if (!config.model) {
    console.error('[deepdive] no model configured (set LOCALCODE_MODEL)')
    process.exit(1)
  }

  const all = loadCivkingsTasks(tasksDir)
  const task = all.find((t) => t.id === taskId)
  if (!task) {
    console.error(`[deepdive] task '${taskId}' not found in ${tasksDir}. Available: ${all.map((t) => t.id).join(', ')}`)
    process.exit(1)
  }
  console.log(`[deepdive] task=${task.id} reps=${reps}/arm safety-timeout=${(timeoutMs / 60000).toFixed(0)}min model=${config.model}`)

  const { provider } = await bootstrapProvider(config)
  const runs: RunRecord[] = []
  try {
    // Interleave arms (governed rep1, ungoverned rep1, ...) so any slow drift in
    // the backend is shared across arms rather than loading one arm.
    for (let rep = 1; rep <= reps; rep++) {
      for (const arm of ['governed', 'ungoverned'] as Arm[]) {
        runs.push(await runOnce(task, arm, rep, config, provider, civkingsRepo, timeoutMs))
      }
    }
  } finally {
    const pm = (globalThis as any).__llamaProcessManager
    if (pm) { try { await pm.stop() } catch {} }
  }

  const outDir = join(import.meta.dirname, 'results')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `deepdive-${task.id}-${Date.now()}.json`)

  const summarise = (arm: Arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const mean = rs.reduce((s, r) => s + r.score, 0) / rs.length
    const best = Math.max(...rs.map((r) => r.score))
    const timeouts = rs.filter((r) => r.timedOut || r.hung).length
    const turns = rs.reduce((s, r) => s + r.turns, 0) / rs.length
    return { arm, n: rs.length, meanScore: mean, bestScore: best, timeouts, avgTurns: turns }
  }
  const govSum = summarise('governed')
  const ungSum = summarise('ungoverned')

  // Per-link pass rate: of N reps, how often did each assertion pass, per arm.
  const linkRate = (arm: Arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const links: Record<string, number> = {}
    for (const r of rs) for (const [name, v] of Object.entries(r.perTest)) {
      links[name] = (links[name] ?? 0) + (v === 'PASSED' ? 1 : 0)
    }
    return Object.fromEntries(Object.entries(links).map(([k, v]) => [k, `${v}/${rs.length}`]))
  }

  writeFileSync(outFile, JSON.stringify({
    task: task.id, model: config.model, reps, safetyTimeoutMs: timeoutMs,
    summary: { governed: govSum, ungoverned: ungSum },
    perLinkPassRate: { governed: linkRate('governed'), ungoverned: linkRate('ungoverned') },
    runs,
  }, null, 2))

  const pct = (x: number) => (x * 100).toFixed(0)
  console.log(`\n=== DEEP DIVE: ${task.id} ===`)
  console.log(`model ${config.model}  reps ${reps}/arm  safety-timeout ${(timeoutMs / 60000).toFixed(0)}min`)
  for (const s of [govSum, ungSum]) {
    console.log(
      `${s.arm.padEnd(10)} mean ${pct(s.meanScore)}%  best ${pct(s.bestScore)}%  ` +
      `timeouts ${s.timeouts}/${s.n}  avg-turns ${s.avgTurns.toFixed(0)}`,
    )
  }
  console.log('per-link pass rate (governed / ungoverned):')
  const allLinks = new Set([...Object.keys(linkRate('governed')), ...Object.keys(linkRate('ungoverned'))])
  for (const link of allLinks) {
    console.log(`  ${link.padEnd(42)} ${(linkRate('governed')[link] ?? '0')} / ${(linkRate('ungoverned')[link] ?? '0')}`)
  }
  // Signal mechanism summary: for each arm, what gated levers actually moved.
  // This is the causal core — it tells us which intervention fired, and whether
  // the runs where it fired are the runs that passed.
  const signalSummary = (arm: Arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const maxStuck = Math.max(0, ...rs.map((r) => Math.max(0, ...r.signalTimeline.map((s) => s.stuckTurns ?? 0))))
    const tempMoved = rs.reduce((n, r) => n + r.signalTimeline.filter((s) => (s.temperatureAdjust ?? 0) !== 0).length, 0)
    const toolGated = rs.reduce((n, r) => n + r.signalTimeline.filter((s) => s.toolRestriction != null).length, 0)
    const notable = rs.reduce((n, r) => n + r.notableEvents.length, 0)
    const algedonic = Math.max(0, ...rs.map((r) => Math.max(0, ...r.signalTimeline.map((s) => s.algedonicAlerts ?? 0))))
    return { maxStuck, tempMovedTurns: tempMoved, toolGatedTurns: toolGated, notableEvents: notable, maxAlgedonic: algedonic }
  }
  console.log('\nsignal mechanism (which gated levers moved):')
  for (const arm of ['governed', 'ungoverned'] as Arm[]) {
    const s = signalSummary(arm)
    console.log(
      `  ${arm.padEnd(10)} max-stuck ${s.maxStuck}  temp-moved-turns ${s.tempMovedTurns}  ` +
      `tool-gated-turns ${s.toolGatedTurns}  algedonic ${s.maxAlgedonic}  notable-events ${s.notableEvents}`,
    )
  }

  console.log(`\nfull evidence (diffs, transcripts, governance events, signal timeline): ${outFile}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
