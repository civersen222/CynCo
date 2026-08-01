/**
 * Join brain telemetry to trajectories and reward labels, and report whether
 * the readings carry any signal worth using.
 *
 * The question this exists to answer: does tool-selection entropy at a turn
 * look different depending on what that turn did, and on how the task was
 * ultimately scored? The mutation harness answers "was this test hollow?"
 * hours after the fact. If entropy separates the same cases, the harness gains
 * an in-flight signal. If it does not, that is a real answer too and this
 * script is how we find out rather than assume.
 *
 * Run: bun scripts/brain-join.ts [--dir ~/.cynco]
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { cyncoHome } from '../engine/paths.js'

type Entropy = { n: number; mean: number; min: number; max: number }
type BrainRow = {
  task_id: string; turn_idx: number; kind: string
  tool_entropy?: Entropy | null
  tool?: string; entropy?: number; floor?: number; diverged?: boolean
}
type TrajRow = {
  task_id: string; turn_idx: number
  tool_calls?: Array<{ name: string; success: boolean }>
  state_features?: { filesTouched?: number; testsTotal?: number; testsFailing?: number }
}
type Reward = { reward?: number; taskCompleted?: unknown; testsPass?: number; labelerVersion?: number }

function readJsonl<T>(path: string): T[] {
  const out: T[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s) as T) } catch { /* a torn tail line is not a row */ }
  }
  return out
}

function loadDir<T>(dir: string, suffix: string): T[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith(suffix)).flatMap(f => readJsonl<T>(join(dir, f)))
}

/** Mean, SD and n of a sample. null when empty — an absent mean is not zero. */
function stats(xs: number[]): { n: number; mean: number; sd: number } | null {
  if (xs.length === 0) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length)
  return { n: xs.length, mean, sd }
}

/** Pearson r, or null when either side is constant or the sample is trivial. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

function fmt(s: { n: number; mean: number; sd: number } | null): string {
  return s ? `mean ${s.mean.toFixed(4)}  sd ${s.sd.toFixed(4)}  n=${s.n}` : 'unmeasured (no observations)'
}

function main(): number {
  const argDir = process.argv.indexOf('--dir')
  const base = argDir >= 0 ? process.argv[argDir + 1] : cyncoHome()
  const brainDir = join(base, 'brain')
  const trajDir = join(base, 'trajectories')
  const rewardDir = join(base, 'rewards')

  const brain = loadDir<BrainRow>(brainDir, '.jsonl')
  const traj = loadDir<TrajRow>(trajDir, '.jsonl')

  if (brain.length === 0) {
    console.log(`No brain telemetry under ${brainDir}.`)
    console.log('Nothing has been recorded since the recorder landed — run a task first.')
    return 1
  }

  const rewards = new Map<string, Reward>()
  if (existsSync(rewardDir)) {
    for (const f of readdirSync(rewardDir).filter(f => f.endsWith('.reward.json'))) {
      try { rewards.set(f.replace(/\.reward\.json$/, ''), JSON.parse(readFileSync(join(rewardDir, f), 'utf-8'))) } catch {}
    }
  }

  const trajBy = new Map<string, TrajRow>()
  for (const t of traj) trajBy.set(`${t.task_id}#${t.turn_idx}`, t)

  const turns = brain.filter(b => b.kind === 'turn')
  const divs = brain.filter(b => b.kind === 'divergence')
  const joined = turns.filter(b => trajBy.has(`${b.task_id}#${b.turn_idx}`))
  const measured = joined.filter(b => b.tool_entropy && b.tool_entropy.n > 0)
  const tasks = new Set(turns.map(b => b.task_id))

  console.log('─── coverage ───')
  console.log(`tasks with telemetry     ${tasks.size}`)
  console.log(`brain turn rows          ${turns.length}`)
  console.log(`joined to a trajectory   ${joined.length}  (${turns.length ? (100 * joined.length / turns.length).toFixed(1) : '0'}%)`)
  console.log(`carrying entropy         ${measured.length}  (${joined.length ? (100 * measured.length / joined.length).toFixed(1) : '0'}% of joined)`)
  console.log(`divergence events        ${divs.length}  (${divs.filter(d => d.diverged).length} above the floor)`)
  console.log(`tasks with a reward       ${[...tasks].filter(t => rewards.has(t)).length}`)

  if (measured.length === 0) {
    console.log('\nNo turn carries an entropy reading. The provider is not returning')
    console.log('logprobs on tool tokens, so there is nothing here to correlate.')
    return 1
  }

  // ─── by tool ─────────────────────────────────────────────────────
  console.log('\n─── mean tool entropy by tool ───')
  const byTool = new Map<string, number[]>()
  for (const b of measured) {
    const t = trajBy.get(`${b.task_id}#${b.turn_idx}`)!
    for (const c of t.tool_calls ?? []) {
      if (!byTool.has(c.name)) byTool.set(c.name, [])
      byTool.get(c.name)!.push(b.tool_entropy!.mean)
    }
  }
  const toolRows = [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [name, xs] of toolRows) console.log(`  ${name.padEnd(18)} ${fmt(stats(xs))}`)

  // ─── by outcome of the turn ──────────────────────────────────────
  const okXs: number[] = [], errXs: number[] = []
  for (const b of measured) {
    const t = trajBy.get(`${b.task_id}#${b.turn_idx}`)!
    const calls = t.tool_calls ?? []
    if (calls.length === 0) continue
    ;(calls.every(c => c.success) ? okXs : errXs).push(b.tool_entropy!.mean)
  }
  console.log('\n─── by whether the tool call succeeded ───')
  console.log(`  succeeded          ${fmt(stats(okXs))}`)
  console.log(`  failed             ${fmt(stats(errXs))}`)

  // ─── by task reward ──────────────────────────────────────────────
  // Per-task mean entropy against the task's reward. This is the correlation
  // the whole exercise is for: if it is flat, entropy tells us nothing about
  // the quality of the work and the harness gains nothing by reading it.
  const perTask = new Map<string, number[]>()
  for (const b of measured) {
    if (!perTask.has(b.task_id)) perTask.set(b.task_id, [])
    perTask.get(b.task_id)!.push(b.tool_entropy!.mean)
  }
  const xs: number[] = [], ys: number[] = []
  for (const [task, es] of perTask) {
    const r = rewards.get(task)
    if (typeof r?.reward !== 'number') continue
    xs.push(es.reduce((a, b) => a + b, 0) / es.length)
    ys.push(r.reward)
  }
  console.log('\n─── per-task mean entropy vs reward ───')
  const r = pearson(xs, ys)
  console.log(`  tasks paired       ${xs.length}`)
  console.log(`  pearson r          ${r === null ? 'unmeasured (need 3+ tasks with varying reward)' : r.toFixed(3)}`)

  if (xs.length < 10) {
    console.log('\nToo few labeled tasks to conclude anything. This is a coverage')
    console.log('report, not a result — the correlation above is noise until the')
    console.log('corpus grows.')
  }
  return 0
}

process.exit(main())
