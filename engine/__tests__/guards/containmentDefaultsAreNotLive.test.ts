/**
 * Under the suite no containment resolver may answer a live folder of the owner's PC, and no test may
 * name the switch that opens the real-profile stage of the acceptance script (F242).
 * "Not the live default" is the assertion, never "inside the temp folder": on Windows the temp folder
 * is inside the home folder, which is exactly where the audit folder may not be.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { auditDir, sandboxRoot } from '../../paths.js'

const LIVE = ['c:/cynco-sandbox', 'c:/cynco-audit', 'c:/cynco-guard']
const fold = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
function expectNotLive(name: string, answer: string | null) {
  expect(answer, `${name} answered nothing under the suite; setup/containment.ts sets its variable`).toBeTruthy()
  expect(LIVE, `${name} answers a live folder under the suite: ${answer}`).not.toContain(fold(answer!))
  expect(existsSync(answer!), `${name} answers a folder that exists (${answer}); the suite's default must refuse`).toBe(false)
}

// Built by concatenation so that this file does not contain what it forbids.
const REAL_FLAG = '--real' + '-profile'
const REAL_VAR = 'LOCALCODE_CONTAINMENT_' + 'REAL_PROFILE'

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) testFiles(p, out)
    else if (/\.(ts|mjs|js|cjs|json)$/.test(name)) out.push(p)
  }
  return out
}

describe('containment defaults under the suite', () => {
  it('the sandbox root is not the live default and does not exist', () => expectNotLive('sandboxRoot()', sandboxRoot()))

  it('the audit folder is not the live default and does not exist (S5)', () => expectNotLive('auditDir()', auditDir()))

  it('no test file names the real-profile flag or its variable', () => {
    const root = process.cwd()
    const offenders = [...testFiles(join(root, 'engine', '__tests__')), ...testFiles(join(root, 'scripts', '__tests__'))]
      .filter(f => { const s = readFileSync(f, 'utf-8'); return s.includes(REAL_FLAG) || s.includes(REAL_VAR) })
    expect(offenders, 'a test that can spell the flag can start the real-profile stage; use the constants the acceptance script exports').toEqual([])
  })
})
