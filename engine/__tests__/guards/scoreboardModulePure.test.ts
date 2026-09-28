import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 5 Task 3, review I2: GET /api/campaign (engine/dashboard/server.ts)
 * loads scripts/cynco-scoreboard.mjs to pool the campaign boards. That route's
 * rule (getCampaign's doc comment) is that a GET carries NO write path — which
 * is why it reads state.json by hand instead of using CampaignState. The rule
 * was a comment; this makes it a test. CynCo missions edit scripts/, so the
 * module must stay pure: it imports nothing outside the allowed list below
 * (today: nothing at all) and names no write, spawn, network or ambient-global
 * call.
 *
 * Final review M4 (T3-M6/M7): the token list covers Bun's own write/spawn,
 * `process.*`, `globalThis`, XMLHttpRequest and WebSocket; and the check is ONE
 * function, `violations(src)`, which both the real test and the bite test call
 * — so a regression in the check fails the bite test instead of passing it.
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '../../..')
const MODULE = join(ROOT, 'scripts', 'cynco-scoreboard.mjs')
const SERVER = join(ROOT, 'engine', 'dashboard', 'server.ts')

/** Pure modules the scoreboard may import. Empty today; adding one is a
 *  reviewed decision, made here, with the reason beside it. */
const ALLOWED_IMPORTS: string[] = []

/** Substrings a pure module never names: writes, spawns, network, ambient globals. */
const FORBIDDEN_TOKENS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'spawn', 'fetch',
  'Bun.write', 'Bun.spawn', 'process.', 'globalThis', 'XMLHttpRequest', 'WebSocket',
]

/** Every purity violation in `src`, as readable strings; [] when pure. */
function violations(src: string): string[] {
  const out: string[] = []
  const specifiers = [
    ...[...src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
  ]
  for (const s of specifiers) if (!ALLOWED_IMPORTS.includes(s)) out.push(`import ${s}`)
  // No computed dynamic import or require either.
  if (/\bimport\s*\(\s*[^'"\s]/.test(src)) out.push('computed import()')
  if (/\brequire\s*\(/.test(src)) out.push('require(')
  for (const token of FORBIDDEN_TOKENS) if (src.includes(token)) out.push(`token ${token}`)
  // `exec` as a call, not RegExp.prototype.exec (`/…/.exec(text)` is pure
  // and the module parses the economics text that way).
  if (/(?<![.\w])exec(Sync|File|FileSync)?\s*\(/.test(src)) out.push('exec call')
  return out
}

const src = readFileSync(MODULE, 'utf-8')

describe('scripts/cynco-scoreboard.mjs stays pure (the dashboard route loads it)', () => {
  it('imports only the allowed pure modules and names no write, spawn, network or ambient-global call', () => {
    expect(violations(src)).toEqual([])
  })

  it('the guard itself bites: every planted violation is caught by the same check', () => {
    const planted: Array<[string, string]> = [
      ["import { writeFileSync } from 'fs'", 'import fs'],
      ["const m = await import('node:child_process')", 'import node:child_process'],
      ['const p = "x"; await import(p)', 'computed import()'],
      ["const fs = require('fs')", 'require('],
      ['writeFileSync("x", "y")', 'token writeFileSync'],
      ['await Bun.write("x", "y")', 'token Bun.write'],
      ['Bun.spawn(["git"])', 'token Bun.spawn'],
      ['const home = process.env.HOME', 'token process.'],
      ['globalThis.fetchLater = 1', 'token globalThis'],
      ['new XMLHttpRequest()', 'token XMLHttpRequest'],
      ['new WebSocket("ws://x")', 'token WebSocket'],
      ['exec("rm -rf /")', 'exec call'],
    ]
    for (const [line, expected] of planted) {
      expect({ line, found: violations(`${src}\n${line}\n`) }).toEqual({ line, found: expect.arrayContaining([expected]) })
    }
    // …and RegExp.prototype.exec stays legal.
    expect(violations(`${src}\n/x/.exec('y')\n`)).toEqual([])
  })

  it('the server loads it lazily inside the route, never at module load', () => {
    const server = readFileSync(SERVER, 'utf-8')
    expect(server).not.toMatch(/^\s*import\s[^;]*?from\s*['"][^'"]*scripts\/cynco-scoreboard\.mjs['"]/m)
    expect(server).toMatch(/import\(\s*'\.\.\/\.\.\/scripts\/cynco-scoreboard\.mjs'\s*\)/)
  })
})
