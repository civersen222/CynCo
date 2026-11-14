/**
 * The Missions history behind `GET /api/mission-history`: every mission the
 * outcome ledger holds (benchmark/cynco-ledger/missions*.jsonl), newest first
 * and paged, whatever launched it — a campaign wave, an authoring run, or a
 * `dispatch-mission.sh` run by hand with no campaign at all. The live mission
 * (`/api/mission`, from the engine's own LOCALCODE_MISSION_* env) is not in the
 * ledger until its driver writes the row at the end; the page draws it above
 * this list.
 *
 * Read through scripts/cynco-ledger-shards.mjs (`shardPaths`, `readShard`: the
 * one reader of the shard layout), loaded lazily like the scoreboard so engine
 * start never depends on a script. The ledger is ~170 MB of full trajectories,
 * so each shard is parsed once, reduced to the few fields the panel shows, and
 * re-read only when its size or mtime moves: the three frozen shards never do,
 * and the active one moves once per mission. A shard that fails to parse (a row
 * caught mid-append) keeps the rows read before and says so in `errors`.
 *
 * Pure of HTTP; reads only. `campaignsDir` (~/.cynco/campaigns) is read for two
 * things: which campaign a pre-`campaignId` row belongs to (a runner campaign's
 * waves.jsonl names its missions), and which campaign ids the Campaign panel
 * lists, so a row links only to a campaign that is there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'

export type LedgerShardsModule = {
  shardPaths: (dir?: string) => string[]
  readShard: (path: string) => any[]
}
const loadLedgerShardsModule = (): Promise<LedgerShardsModule> =>
  // @ts-expect-error — .mjs script, no types.
  import('../../scripts/cynco-ledger-shards.mjs') as Promise<LedgerShardsModule>

/** One mission as the panel shows it. A field the row does not carry is null, never a guess. */
export interface MissionRow {
  missionId: string
  /** The campaign the mission ran under: the row's own `campaignId`, else the runner campaign whose waves.jsonl names it. */
  campaignId: string | null
  /** Where `campaignId` came from; null when the mission ran under none. */
  campaignFrom: 'ledger' | 'waves' | null
  /** The Campaign panel's campaign this row opens, or null (a hand-run series or an authoring run has no campaign directory). */
  campaignLink: string | null
  cwd: string | null
  briefFile: string | null
  marker: string | null
  markerSeen: boolean | null
  dispatchedAt: string | null
  durationS: number | null
  outcome: string | null
  verified: boolean | null
  /** The driver's check (`verify`): the command and what it said; null when the mission had no check-cmd. */
  check: { command: string | null; result: string; tail: string } | null
  exitReason: string | null
  commitRange: { base: string | null; head: string | null } | null
  /** How many governance turns the row recorded. */
  turns: number | null
  graderProbes: { total: number | null; probes: number | null; uninspectable: number | null } | null
  /** `<shard file>:<line>` (1-based), so a row can be found in the ledger. */
  ledger: string
}

export interface MissionHistoryPage {
  total: number
  offset: number
  limit: number
  /** The filter applied: a campaign id, `none` for missions with no campaign, or null for all. */
  campaign: string | null
  /** Every campaign id among the missions with its count (`campaignId: null` = none), most missions first. */
  groups: Array<{ campaignId: string | null; count: number }>
  missions: MissionRow[]
  /** Shards that could not be read this time (their earlier rows, if any, are still listed). */
  errors: string[]
}

export const MISSION_HISTORY_DEFAULT_LIMIT = 25
export const MISSION_HISTORY_MAX_LIMIT = 100
/** The last lines of a check's output on the row, for the hover; a check's whole output is in the ledger. */
const CHECK_TAIL_CHARS = 300

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** What the driver's check said, in words: `exit 0`, `timed out`, `did not start`, `harness fault: …`. */
export function checkResult(v: any): string {
  if (v?.timedOut === true) return 'timed out'
  if (v?.spawnFailed === true) return 'did not start'
  if (typeof v?.harnessFault === 'string' && v.harnessFault) return `harness fault: ${v.harnessFault}`
  if (typeof v?.exitCode === 'number') return `exit ${v.exitCode}`
  return 'no result recorded'
}

/** One ledger record reduced to the panel's fields; `campaignId`'s waves fallback and the link are filled in later. */
export function reduceLedgerRow(row: any, at: { shard: string; line: number }): MissionRow {
  const v = row?.verify && typeof row.verify === 'object' ? row.verify : null
  const gp = row?.graderProbes && typeof row.graderProbes === 'object' ? row.graderProbes : null
  const cr = row?.commitRange && typeof row.commitRange === 'object' ? row.commitRange : null
  const campaignId = str(row?.campaignId)
  return {
    missionId: String(row?.missionId ?? `${basename(at.shard)}:${at.line + 1}`),
    campaignId,
    campaignFrom: campaignId ? 'ledger' : null,
    campaignLink: null,
    cwd: str(row?.cwd),
    briefFile: str(row?.briefFile),
    marker: str(row?.marker),
    markerSeen: bool(row?.markerSeen),
    dispatchedAt: str(row?.dispatchedAt),
    durationS: num(row?.durationS),
    outcome: str(row?.outcome),
    verified: bool(row?.verified),
    check: v ? { command: str(v.command), result: checkResult(v), tail: String(v.outputTail ?? '').slice(-CHECK_TAIL_CHARS) } : null,
    exitReason: str(row?.exitReason),
    commitRange: cr ? { base: str(cr.base), head: str(cr.head) } : null,
    turns: Array.isArray(row?.turns) ? row.turns.length : null,
    graderProbes: gp ? { total: num(gp.total), probes: num(gp.probes), uninspectable: num(gp.uninspectable) } : null,
    ledger: `${basename(at.shard)}:${at.line + 1}`,
  }
}

/**
 * The runner campaigns under `campaignsDir`: `missions` maps every missionId a
 * waves.jsonl names to its campaign (how a row written before the ledger
 * carried `campaignId` finds its campaign), `listed` is every campaign id the
 * Campaign panel shows (a directory with a state.json). A bad line or file is
 * skipped and logged, never the whole map.
 */
export function readRunnerCampaigns(campaignsDir: string): { missions: Map<string, string>; listed: Set<string> } {
  const missions = new Map<string, string>()
  const listed = new Set<string>()
  if (!existsSync(campaignsDir)) return { missions, listed }
  for (const d of readdirSync(campaignsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(campaignsDir, d.name)
    if (existsSync(join(dir, 'state.json'))) listed.add(d.name)
    const wavesPath = join(dir, 'waves.jsonl')
    if (!existsSync(wavesPath)) continue
    try {
      for (const line of readFileSync(wavesPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const w = JSON.parse(line)
          if (typeof w?.missionId === 'string' && w.missionId) missions.set(w.missionId, d.name)
        } catch (e) {
          console.warn(`[dashboard] mission history: ${d.name}/waves.jsonl has an unparseable line, skipped (${e instanceof Error ? e.message : String(e)})`)
        }
      }
    } catch (e) {
      console.warn(`[dashboard] mission history: ${wavesPath} unreadable, its missions show no campaign (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return { missions, listed }
}

/** Newest first: by dispatch time, and by ledger position where it ties or is missing. */
function newestFirst(rows: Array<{ row: MissionRow; order: number }>): MissionRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.row.dispatchedAt ?? '', tb = b.row.dispatchedAt ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return b.order - a.order
  }).map(r => r.row)
}

export class MissionHistory {
  private shards = new Map<string, { size: number; mtimeMs: number; rows: MissionRow[] }>()
  private module: Promise<LedgerShardsModule> | null = null
  private refreshing: Promise<string[]> | null = null

  constructor(private readonly opts: { ledgerDir?: string; load?: () => Promise<LedgerShardsModule> } = {}) {}

  private shardsModule(): Promise<LedgerShardsModule> {
    if (!this.module) {
      const loading = (this.opts.load ?? loadLedgerShardsModule)()
      this.module = loading
      // A rejected load is not kept: the next poll tries again.
      loading.catch(() => { if (this.module === loading) this.module = null })
    }
    return this.module
  }

  /** Re-read each shard whose size or mtime moved; single-flight, so two polls never parse the ledger twice. */
  private refresh(): Promise<string[]> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const errors: string[] = []
      const mod = await this.shardsModule()
      const paths = mod.shardPaths(this.opts.ledgerDir)
      const seen = new Set(paths)
      for (const p of [...this.shards.keys()]) if (!seen.has(p)) this.shards.delete(p)
      for (const p of paths) {
        let st: { size: number; mtimeMs: number }
        try { st = statSync(p) } catch (e) { errors.push(`${basename(p)}: not readable (${e instanceof Error ? e.message : String(e)})`); continue }
        const had = this.shards.get(p)
        if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) continue
        try {
          const rows = mod.readShard(p).map((r: any, i: number) => reduceLedgerRow(r, { shard: p, line: typeof r?.__line === 'number' ? r.__line : i }))
          this.shards.set(p, { size: st.size, mtimeMs: st.mtimeMs, rows })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          errors.push(`${basename(p)}: ${had ? 'could not be re-read, showing the rows read before' : 'could not be read'} (${message})`)
          console.warn(`[dashboard] mission history: ${p} ${had ? 'not re-read' : 'not read'} (${message})`)
        }
        // Yield between shards: the first read parses ~170 MB, and the dashboard,
        // the phone and a Stop are all answered from this loop (F225).
        await new Promise<void>(r => setImmediate(r))
      }
      return errors
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  /** One page of the history. `campaign`: an id, `none` (no campaign), or null for every mission. */
  async page({ offset = 0, limit = MISSION_HISTORY_DEFAULT_LIMIT, campaign = null, campaignsDir }:
    { offset?: number; limit?: number; campaign?: string | null; campaignsDir: string }): Promise<MissionHistoryPage> {
    let errors: string[]
    try { errors = await this.refresh() } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[dashboard] mission history: the ledger reader did not load (${message})`)
      errors = [`scripts/cynco-ledger-shards.mjs did not load (${message})`]
    }
    const runner = readRunnerCampaigns(campaignsDir)
    const all: Array<{ row: MissionRow; order: number }> = []
    let order = 0
    for (const { rows } of this.shards.values()) {
      for (const r of rows) {
        const fromWaves = !r.campaignId ? runner.missions.get(r.missionId) ?? null : null
        const campaignId = r.campaignId ?? fromWaves
        all.push({ order: order++, row: { ...r, campaignId, campaignFrom: r.campaignId ? 'ledger' : fromWaves ? 'waves' : null,
          campaignLink: campaignId && runner.listed.has(campaignId) ? campaignId : null } })
      }
    }
    const counts = new Map<string | null, number>()
    for (const { row } of all) counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1)
    const groups = [...counts.entries()].map(([campaignId, count]) => ({ campaignId, count }))
      .sort((a, b) => b.count - a.count || String(a.campaignId ?? '').localeCompare(String(b.campaignId ?? '')))
    const filtered = campaign === null ? all : all.filter(({ row }) => (campaign === 'none' ? row.campaignId === null : row.campaignId === campaign))
    const sorted = newestFirst(filtered)
    const lim = Math.min(Math.max(1, Math.floor(limit)), MISSION_HISTORY_MAX_LIMIT)
    const off = Math.max(0, Math.floor(offset))
    return { total: sorted.length, offset: off, limit: lim, campaign, groups, missions: sorted.slice(off, off + lim), errors }
  }
}

/** `offset`, `limit` and `campaign` off the query string; anything malformed is the default, never a 400. */
export function missionHistoryQuery(url: URL): { offset: number; limit: number; campaign: string | null } {
  const int = (k: string, d: number) => { const n = Number(url.searchParams.get(k)); return Number.isInteger(n) && n >= 0 ? n : d }
  const c = url.searchParams.get('campaign')
  return { offset: int('offset', 0), limit: int('limit', MISSION_HISTORY_DEFAULT_LIMIT) || MISSION_HISTORY_DEFAULT_LIMIT, campaign: c && c.trim() ? c.trim() : null }
}
