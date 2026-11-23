/**
 * Make the suite's containment defaults refuse (F242).
 *
 * The sandbox root, the guard folder and the audit folder default to live folders on the owner's PC
 * (C:/cynco-sandbox, C:/cynco-guard, C:/cynco-audit). setup/hostEnv.ts clears every LOCALCODE_* the
 * launching shell exports, so without this file the suite would run on those defaults: a test could
 * take a manifest of the owner's protected folders, write the real integrity latch, or append to the
 * real audit log. This file points the three at a folder that is NEVER created, so every default
 * resolver answers a place that refuses. A test that needs a folder names its own (testContainment,
 * or establishContainment({ test: true, ... }) with every folder under its own mkdtemp root).
 *
 * The beforeEach puts the three keys back, because config.test.ts (three places) and hostEnv.test.ts
 * delete every LOCALCODE_* themselves and would otherwise hand the live defaults to the tests after them.
 * CYNCO_NTFY_* is cleared so that no test can page the owner's phone through an inherited variable.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach } from 'vitest'

/** A folder that is never created: every default resolver answers a place that refuses. */
export const SUITE_NOWHERE = join(tmpdir(), 'cynco-suite-does-not-exist')
export const SUITE_CONTAINMENT_ENV: Readonly<Record<string, string>> = {
  LOCALCODE_SANDBOX_ROOT: join(SUITE_NOWHERE, 'sandbox'),
  LOCALCODE_GUARD_DIR: join(SUITE_NOWHERE, 'guard'),
  LOCALCODE_AUDIT_DIR: join(SUITE_NOWHERE, 'audit'),
}
export function applySuiteContainment(env: Record<string, string | undefined> = process.env): void {
  for (const [k, v] of Object.entries(SUITE_CONTAINMENT_ENV)) env[k] = v
  for (const k of Object.keys(env)) if (k.startsWith('CYNCO_NTFY_')) delete env[k]
}
applySuiteContainment()
beforeEach(() => applySuiteContainment())
