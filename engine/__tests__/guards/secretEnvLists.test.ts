/**
 * The secret-key lists of the starters and of toolEnv (NOW.md, "Cut, isolation": one shared secret-key list
 * for dispatchEnv, TaskRunner and cynco-ideation.mjs as well as toolEnv).
 *
 * Four places decide which keys of the environment are secrets: `SECRET_ENV` (engine/containment.ts), which
 * toolEnv strips from every child of a contained run; and the three starters of an unattended engine, which
 * strip keys from the engine's own environment: the dispatch (`dispatchEnv`, scripts/cynco-campaign.mjs), the
 * daemon's task runner (engine/daemon/taskRunner.ts) and the ideation one-shot (scripts/cynco-ideation.mjs).
 *
 * They do not name the same keys, and they need not: the engine itself needs the provider's key
 * (`LOCALCODE_API_KEY`, `OPENAI_API_KEY`), which the starters therefore pass and toolEnv strips from the
 * tools. What must hold is that a key some starter treats as a secret is never handed to a tool: every key a
 * starter strips is one SECRET_ENV strips, and every starter strips the pager (`CYNCO_NTFY_*`), the owner's
 * own alert channel. The starters' lists are also pinned as they stand on 2026-11-24, so that a key added to
 * one of them is a failure here and a decision about the other three. The starters are read as text: this
 * guard calls none of them.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECRET_ENV } from '../../containment.js'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** The keys a starter's environment loop leaves out, read from its source: `startsWith('X')` is `X*`, `k === 'Y'` is `Y`. */
export function strippedKeys(source: string): string[] {
  const out: string[] = []
  for (const line of source.split(/\r?\n/)) {
    // The loop's own line: it tests `k` and either skips the key or copies the rest.
    if (!/\bk\.startsWith\(|\bk === '/.test(line) || !/continue|env\[k\] = v/.test(line)) continue
    for (const m of line.matchAll(/k\.startsWith\('([A-Z0-9_]+)'\)/g)) out.push(`${m[1]}*`)
    for (const m of line.matchAll(/k === '([A-Z0-9_]+)'/g)) out.push(m[1]!)
  }
  return out
}

/** Whether SECRET_ENV strips the key (a `X*` key: a name that starts with X). */
const toolEnvStrips = (key: string): boolean => {
  const name = key.endsWith('*') ? `${key.slice(0, -1)}SAMPLE` : key
  return SECRET_ENV.some(re => re.test(name))
}

const STARTERS: Array<{ file: string; who: string; stands: string[] }> = [
  { file: 'scripts/cynco-campaign.mjs', who: 'dispatchEnv', stands: ['CYNCO_NTFY_*', 'GH_TOKEN', 'GITHUB_TOKEN'] },
  { file: 'engine/daemon/taskRunner.ts', who: 'the task runner', stands: ['CYNCO_NTFY_*'] },
  { file: 'scripts/cynco-ideation.mjs', who: 'the ideation one-shot', stands: ['CYNCO_NTFY_*'] },
]

describe('the secret-key lists of the starters and of toolEnv', () => {
  it('the reader: a skip line and a copy line give their keys; other lines give none', () => {
    expect(strippedKeys("    if (k.startsWith('CYNCO_NTFY_') || k === 'GH_TOKEN') continue")).toEqual(['CYNCO_NTFY_*', 'GH_TOKEN'])
    expect(strippedKeys("for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CYNCO_NTFY_')) env[k] = v")).toEqual(['CYNCO_NTFY_*'])
    expect(strippedKeys("if (k.startsWith('LOCALCODE_MISSION_')) return true")).toEqual([])
  })

  for (const s of STARTERS) {
    it(`${s.who} (${s.file}): its list as it stands, every key of it stripped by SECRET_ENV, the pager among them`, () => {
      const keys = strippedKeys(readFileSync(join(ROOT, s.file), 'utf8'))
      expect(keys, `${s.who}'s secret keys changed: decide them for the three other lists too`).toEqual(s.stands)
      expect(keys.filter(k => !toolEnvStrips(k)), `keys ${s.who} treats as secrets that toolEnv would hand to a tool`).toEqual([])
      expect(keys).toContain('CYNCO_NTFY_*')
    })
  }

  it('SECRET_ENV strips the pager, the GitHub tokens and the provider keys', () => {
    for (const k of ['CYNCO_NTFY_URL', 'CYNCO_NTFY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'LOCALCODE_API_KEY', 'OPENAI_API_KEY']) expect(toolEnvStrips(k), k).toBe(true)
  })
})
