// engine/tools/impl/mfl.ts
// Read-only MyFantasyLeague API tool. Write endpoints (TYPE=import) are
// deliberately unreachable — Phase C will add them behind S5 approval gates.
import type { ToolImpl } from '../types.js'

const ALLOWED_QUERIES = new Set([
  'league',          // league settings, franchises, deep links
  'rosters',         // all franchise rosters
  'players',         // player id → name/team/pos database
  'playerScores',    // weekly/season scores
  'transactions',    // waivers, trades, drops league-wide
  'leagueStandings', // standings
  'injuries',        // official injury report
  'pendingTrades',   // trades awaiting action
  'freeAgents',      // available players
  'futureDraftPicks',// dynasty draft pick ownership
  'assets',          // all tradeable assets per franchise
  'projectedScores', // weekly projections under THIS league's scoring (W=week)
  'playerRanks',     // dynasty trade-value rankings (global)
  'nflSchedule',     // NFL matchups + byes for a week (global, W=week)
])

// Global (league-independent) queries. Sending L= makes api.myfantasyleague.com
// 302 to the league host, which rejects these TYPEs with "must go to
// api.myfantasyleague.com" (2026-06-12 weekly-digest incident). Omit L.
const GLOBAL_QUERIES = new Set(['injuries', 'playerRanks', 'nflSchedule'])

export function buildMflExportUrl(opts: {
  query: string
  league: string
  year: number
  apiKey?: string
  extra?: Record<string, string>
}): string {
  // SECURITY: extra is model-controlled. Reserved params (TYPE/L/JSON/APIKEY)
  // are dropped from extra and set canonically AFTER it, so a tool call can
  // never rewrite TYPE=import (write endpoint) or retarget another league.
  const RESERVED = new Set(['TYPE', 'L', 'JSON', 'APIKEY'])
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    if (RESERVED.has(k.toUpperCase())) continue
    params.set(k, v)
  }
  params.set('TYPE', opts.query)
  if (!GLOBAL_QUERIES.has(opts.query)) params.set('L', opts.league)
  params.set('JSON', '1')
  if (opts.apiKey) params.set('APIKEY', opts.apiKey)
  // URLSearchParams encodes; MFL accepts encoded params fine
  return `https://api.myfantasyleague.com/${opts.year}/export?${params.toString()}`
}

export function loadMflApiKey(): string | undefined {
  try {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')
    const p = path.join(os.homedir(), '.cynco', 'credentials', 'mfl.json')
    if (!fs.existsSync(p)) return undefined
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined
  } catch {
    return undefined
  }
}

function redact(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join('***') : text
  // Also redact any APIKEY=<value> pattern that may appear in error messages
  out = out.replace(/APIKEY=[^&\s"']*/g, 'APIKEY=***')
  return out
}

export const mflTool: ToolImpl = {
  name: 'Mfl',
  description:
    'Query the MyFantasyLeague (MFL) fantasy football API (read-only). ' +
    `Queries: ${[...ALLOWED_QUERIES].join(', ')}. ` +
    'Returns raw JSON. Use extra params like {"W": "3"} for week or {"FRANCHISE": "0005"} to filter. ' +
    'IMPORTANT: the players query returns the ENTIRE league player database unless filtered — ' +
    'to look up specific players (e.g. ids from rosters), always pass {"PLAYERS": "id1,id2,..."}.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'MFL export TYPE (e.g. rosters, transactions, injuries)' },
      league: { type: 'string', description: 'MFL league id' },
      year: { type: 'number', description: 'League year (default: current year)' },
      extra: { type: 'object', description: 'Extra query params, e.g. {"W": "3", "FRANCHISE": "0005"}' },
    },
    required: ['query', 'league'],
  },
  tier: 'auto',
  core: false,
  execute: async (input) => {
    const query = String(input.query ?? '')
    if (!ALLOWED_QUERIES.has(query)) {
      return {
        output: `Error: MFL query "${query}" is not allowed. Allowed (read-only): ${[...ALLOWED_QUERIES].join(', ')}`,
        isError: true,
      }
    }
    const league = String(input.league ?? '')
    const year = typeof input.year === 'number' ? input.year : new Date().getFullYear()
    const extra = (input.extra && typeof input.extra === 'object') ? input.extra as Record<string, string> : undefined
    const apiKey = loadMflApiKey()
    const url = buildMflExportUrl({ query, league, year, apiKey, extra })

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'CynCoMFL/1.0' },  // must match the UA prefix registered with MFL's API client program
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return { output: redact(`MFL HTTP ${resp.status}: ${resp.statusText}`, apiKey), isError: true }
      let text = await resp.text()
      const maxLen = 50000
      if (text.length > maxLen) text = text.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`
      return { output: redact(text, apiKey), isError: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: redact(`MFL fetch error: ${msg}`, apiKey), isError: true }
    }
  },
}
