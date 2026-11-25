/**
 * Wave 19b, C19-3: the path check's resolver (`realPathChecked`, `toolPaths.ts`) lists a folder to tell whether
 * an entry that does not resolve is a link. One call that names many new files in one folder listed that folder
 * once per file, on the event loop that also answers the phone and Stop (F225). Within one judgement of one call
 * (`checkProtectedPaths`) a folder is now listed once.
 *
 * The count is taken on `readdirSync` itself (the module is wrapped for this file only), so it holds whichever
 * helper does the listing. Linux: the same folders on its temp folder; nothing here is Windows-only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const listed: string[] = []
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readdirSync = ((p: Parameters<typeof fs.readdirSync>[0], o?: unknown) => {
    listed.push(String(p))
    return (fs.readdirSync as (a: unknown, b?: unknown) => unknown)(p, o)
  }) as typeof fs.readdirSync
  return { ...fs, readdirSync, default: { ...fs, readdirSync } }
})

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testContainment, type RunContainment } from '../../containment.js'
import { checkProtectedPaths } from '../../tools/protectedPaths.js'

let root = ''
let ctx: RunContainment
let mission = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pp-listing-')))
  const home = join(root, 'home')
  mkdirSync(join(home, '.cynco'), { recursive: true })
  mission = join(root, 'proj')
  mkdirSync(join(mission, 'out'), { recursive: true })
  const sbr = join(root, 'sandbox', 'run1')
  const sb = { root: sbr, home: join(sbr, 'home'), tmp: join(sbr, 'tmp'), scratch: join(sbr, 'scratch') }
  for (const d of [sb.home, sb.tmp, sb.scratch]) mkdirSync(d, { recursive: true })
  const folders = { state: join(home, '.cynco'), models: join(root, 'models'), guard: join(root, 'guard'), audit: join(root, 'audit') }
  for (const d of [folders.models, folders.guard, folders.audit]) mkdirSync(d)
  writeFileSync(join(folders.audit, '.cynco-audit'), '')
  ctx = testContainment({ missionCwd: mission, home, sandbox: sb, folders })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('the path check lists a folder once per call (19b, C19-3)', () => {
  it('a MultiEdit naming 20 new files in one folder lists that folder at most once, and is allowed', () => {
    // A first call builds the run context (its roots), so the count below is the call's own.
    expect(checkProtectedPaths('Write', { file_path: join(mission, 'warm.txt'), content: 'x' }, mission, ctx).kind).toBe('allow')
    const out = join(mission, 'out')
    const edits = Array.from({ length: 20 }, (_, i) => ({ file_path: join(out, `f${i}.txt`), old_string: 'a', new_string: 'b' }))
    listed.length = 0
    const v = checkProtectedPaths('MultiEdit', { edits }, mission, ctx)
    expect(v.kind).toBe('allow')
    const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
    const ofOut = listed.filter(p => fold(p) === fold(out))
    expect(ofOut.length, `listings of ${out}: ${ofOut.length}`).toBeLessThanOrEqual(1)
  })
})
