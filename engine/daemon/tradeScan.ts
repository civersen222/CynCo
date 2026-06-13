// engine/daemon/tradeScan.ts
// League-wide trade scan orchestrator (spec §3, 2026-06-12-mfl-lineup-trade).
// Runs INSIDE the one-shot engine process (dispatched from oneShot.ts when
// taskType === 'trade-scan') so all passes share one model load:
//   pass 0      deterministic MFL fetches — no model
//   pass 1..N   one tool-free completion per rival roster → candidate trades
//   final pass  one governed ConversationLoop ranks candidates → outcome contract
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import type { MflLeagueRef, TaskFileInput, TaskOutcome } from './types.js'
import { buildMflExportUrl, loadMflApiKey } from '../tools/impl/mfl.js'
import { runGovernedLoop } from './oneShot.js'

const PASS_MAX_TOKENS = 2048
const RANKING_TIMEOUT_MS = 15 * 60 * 1000
const MIN_SUCCESSFUL_PASSES = 2

export interface TradeCandidate {
  rivalId: string
  give: string[]
  get: string[]
  rationale: string
}

/** All side effects injected — tests run the full orchestration offline. */
export interface TradeScanDeps {
  /** MFL export fetch, parsed JSON. League/year/key are baked in by the factory. */
  fetchMfl: (query: string, extra?: Record<string, string>) => Promise<any>
  /** One tool-free model completion (per-rival pass). */
  completeText: (prompt: string) => Promise<string>
  /** The governed ranking loop (oneShot.runGovernedLoop with mission tools). */
  runRanking: (prompt: string, context: string) => Promise<TaskOutcome>
  /** Persist raw per-pass model output next to the outcome file (debugging). */
  writeIntermediate: (name: string, content: string) => void
  log: (msg: string) => void
}

// ─── MFL JSON helpers ────────────────────────────────────────────

/** MFL quirk: single-element collections arrive as an object, not an array. */
function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return []
  return Array.isArray(x) ? x : [x]
}

interface FranchiseData {
  id: string
  name: string
  standing: string
  rosterText: string
}

async function buildLeagueData(deps: TradeScanDeps): Promise<FranchiseData[]> {
  const [leagueResp, rostersResp, ranksResp, standingsResp, injuriesResp] = [
    await deps.fetchMfl('league'),
    await deps.fetchMfl('rosters'),
    await deps.fetchMfl('playerRanks'),
    await deps.fetchMfl('leagueStandings'),
    await deps.fetchMfl('injuries'),
  ]

  const franchises = asArray(leagueResp?.league?.franchises?.franchise)
    .map((f: any) => ({ id: String(f.id), name: String(f.name ?? `franchise ${f.id}`) }))

  const rosterIds = new Map<string, string[]>()
  for (const fr of asArray<any>(rostersResp?.rosters?.franchise)) {
    rosterIds.set(String(fr.id), asArray<any>(fr.player).map((p) => String(p.id)))
  }

  const allIds = [...new Set([...rosterIds.values()].flat())]
  const playersResp = await deps.fetchMfl('players', { PLAYERS: allIds.join(',') })
  const playerInfo = new Map<string, { name: string; position: string; team: string }>()
  for (const p of asArray<any>(playersResp?.players?.player)) {
    playerInfo.set(String(p.id), {
      name: String(p.name ?? p.id),
      position: String(p.position ?? '?'),
      team: String(p.team ?? '?'),
    })
  }

  const rankOf = new Map<string, string>()
  for (const p of asArray<any>(ranksResp?.playerRanks?.player)) {
    rankOf.set(String(p.id), String(p.rank))
  }

  const standingOf = new Map<string, string>()
  for (const f of asArray<any>(standingsResp?.leagueStandings?.franchise)) {
    standingOf.set(String(f.id), `${f.h2hw ?? '0'}-${f.h2hl ?? '0'}`)
  }

  const injuryOf = new Map<string, string>()
  for (const i of asArray<any>(injuriesResp?.injuries?.injury)) {
    injuryOf.set(String(i.id), String(i.status ?? 'listed'))
  }

  return franchises.map((f) => {
    const lines = (rosterIds.get(f.id) ?? []).map((pid) => {
      const info = playerInfo.get(pid)
      const rank = rankOf.get(pid)
      const injury = injuryOf.get(pid)
      const base = info ? `${info.position} ${info.name} (${info.team})` : `player ${pid}`
      return `  ${base}${rank ? ` — rank ${rank}` : ''}${injury ? ` — INJURY: ${injury}` : ''}`
    })
    return {
      id: f.id,
      name: f.name,
      standing: standingOf.get(f.id) ?? '0-0',
      rosterText: lines.join('\n') || '  (roster unavailable)',
    }
  })
}

// ─── Per-rival pass ──────────────────────────────────────────────

function buildRivalPrompt(me: FranchiseData, rival: FranchiseData): string {
  return [
    'You are a dynasty fantasy football trade analyst. Find trades where BOTH sides plausibly say yes.',
    'Lower rank number = more valuable player.',
    '',
    `MY TEAM "${me.name}" (record ${me.standing}):`,
    me.rosterText,
    '',
    `RIVAL TEAM "${rival.name}" (record ${rival.standing}):`,
    rival.rosterText,
    '',
    'Propose 0-2 mutually beneficial trades between MY TEAM and this RIVAL only.',
    'A good trade exchanges my surplus for my need and fits the rival\'s roster shape too.',
    'If no fair trade exists, return an empty array — do NOT force one.',
    '',
    'Respond with ONLY one fenced code block in exactly this format:',
    '```json',
    '{"candidates": [{"give": ["<player I send>"], "get": ["<player I receive>"], "rationale": "<one sentence: why both sides accept>"}]}',
    '```',
  ].join('\n')
}

/** Parse candidate trades from a per-rival pass. null = pass FAILED (no
 *  parsable block); [] = pass succeeded, no trades found. */
export function parseCandidates(text: string): { give: string[]; get: string[]; rationale: string }[] | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(blocks[i])
      if (!Array.isArray(raw.candidates)) continue
      return raw.candidates
        .filter((c: any) => c
          && Array.isArray(c.give) && c.give.every((g: any) => typeof g === 'string')
          && Array.isArray(c.get) && c.get.every((g: any) => typeof g === 'string')
          && typeof c.rationale === 'string')
        .slice(0, 2)
        .map((c: any) => ({ give: c.give, get: c.get, rationale: c.rationale }))
    } catch {
      // try the previous block
    }
  }
  return null
}

// ─── Orchestration ───────────────────────────────────────────────

export async function runTradeScan(
  task: TaskFileInput,
  provider: Provider,
  config: LocalCodeConfig,
  depsOverride?: TradeScanDeps,
): Promise<TaskOutcome> {
  const league = task.leagues?.[0]
  if (!league) {
    return { ok: false, summary: '', recommendations: [], error: 'trade-scan task carries no leagues — missionRunner must pass them through' }
  }
  const deps = depsOverride ?? makeRealDeps(task, league, provider, config)
  try {
    return await scan(task, league, deps)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log(`[trade-scan] failed: ${msg}`)
    return { ok: false, summary: '', recommendations: [], error: msg }
  }
}

async function scan(task: TaskFileInput, league: MflLeagueRef, deps: TradeScanDeps): Promise<TaskOutcome> {
  const franchises = await buildLeagueData(deps)
  const me = franchises.find((f) => f.id === league.franchiseId)
  if (!me) {
    return { ok: false, summary: '', recommendations: [], error: `franchise ${league.franchiseId} not found in league ${league.leagueId}` }
  }
  const rivals = franchises.filter((f) => f.id !== league.franchiseId)

  const candidates: TradeCandidate[] = []
  let successes = 0
  for (const rival of rivals) {
    try {
      const text = await deps.completeText(buildRivalPrompt(me, rival))
      deps.writeIntermediate(`pass-${rival.id}`, text)
      const parsed = parseCandidates(text)
      if (parsed === null) {
        deps.log(`[trade-scan] pass ${rival.id} (${rival.name}): no parsable candidates block — skipped`)
        continue
      }
      successes++
      candidates.push(...parsed.map((c) => ({ ...c, rivalId: rival.id })))
      deps.log(`[trade-scan] pass ${rival.id} (${rival.name}): ${parsed.length} candidate(s)`)
    } catch (err) {
      deps.log(`[trade-scan] pass ${rival.id} (${rival.name}) failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (successes < MIN_SUCCESSFUL_PASSES) {
    return { ok: false, summary: '', recommendations: [], error: `trade scan: only ${successes}/${rivals.length} rival passes succeeded` }
  }
  if (candidates.length === 0) {
    return { ok: true, summary: `Scanned ${successes} rival rosters — no mutually beneficial trades found this week.`, recommendations: [] }
  }

  const context = [
    task.context,
    '',
    'Candidate trades from the per-rival scan (rivalId = the rival franchise id):',
    '```json',
    JSON.stringify({ candidates }, null, 1),
    '```',
  ].join('\n')
  return deps.runRanking(task.prompt, context)
}

// ─── Real deps ───────────────────────────────────────────────────

function makeRealDeps(
  task: TaskFileInput,
  league: MflLeagueRef,
  provider: Provider,
  config: LocalCodeConfig,
): TradeScanDeps {
  const apiKey = loadMflApiKey()
  const stamp = Date.now()
  const outDir = dirname(task.outcomePath)
  return {
    fetchMfl: async (query, extra) => {
      const url = buildMflExportUrl({ query, league: league.leagueId, year: league.year, apiKey, extra })
      const resp = await fetch(url, { headers: { 'User-Agent': 'CynCoMFL/1.0' }, signal: AbortSignal.timeout(30000) })
      if (!resp.ok) throw new Error(`MFL HTTP ${resp.status} for ${query}`)
      return resp.json()
    },
    completeText: async (prompt) => {
      const resp = await provider.complete({
        model: config.model ?? '',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: PASS_MAX_TOKENS,
        temperature: 0.7,
      })
      return resp.content
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
    },
    runRanking: (prompt, context) => runGovernedLoop({
      prompt, context,
      allowedTools: ['Mfl', 'WebSearch', 'WebFetch'],
      timeoutMs: RANKING_TIMEOUT_MS,
      provider, config,
    }),
    writeIntermediate: (name, content) => {
      try {
        writeFileSync(join(outDir, `tradescan-${stamp}-${name}.txt`), content, 'utf-8')
      } catch { /* debugging aid only — never fail the scan over it */ }
    },
    log: (msg) => console.log(msg),
  }
}
