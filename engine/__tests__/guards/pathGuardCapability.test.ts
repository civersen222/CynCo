/**
 * F242, layer 2: the engine says `path-guard` only when the path check answers correctly for its own run.
 *
 * Modelled on `liveSealCapability.test.ts`: the word is a MEASUREMENT (`pathGuardProbe`, four decisions
 * against the live run context), the driver refuses a dispatch without it (`containmentDispatchRefusal`),
 * and the boot block refuses a contained run whose path check is faulty (step 4, `pathGuardFault`) before
 * the model loads. The source pins below keep the layering the specification relies on: the naming module
 * imports nothing that imports the policy, the policy reads no environment, and the shell blocklist's
 * environment rule is the one this work started from.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CAP_CONTAINED,
  CAP_PATH_GUARD,
  CAP_SEALED_GATES,
  governanceCapabilities,
} from '../../bridge/capabilities.js'
// @ts-ignore — untyped harness module
import { CAP_PATH_GUARD as CONTRACT_PATH_GUARD, containmentDispatchRefusal } from '../../../scripts/cynco-contract.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8').replace(/\r\n/g, '\n')

/** A wiring whose other guarantees hold, so only the path-guard member decides the word. */
const wiring = (pathGuard?: () => boolean) => ({
  seal: () => {},
  probe: () => true,
  unseal: () => {},
  s5Enforcing: () => false,
  contained: () => 'verified' as const,
  ...(pathGuard ? { pathGuard } : {}),
})

describe('governanceCapabilities: path-guard is measured, never claimed', () => {
  it('advertises path-guard when the live probe answers true', () => {
    expect(governanceCapabilities(wiring(() => true))).toContain(CAP_PATH_GUARD)
  })

  it('does not advertise it when the probe answers false or is absent', () => {
    expect(governanceCapabilities(wiring(() => false))).not.toContain(CAP_PATH_GUARD)
    expect(governanceCapabilities(wiring())).not.toContain(CAP_PATH_GUARD)
  })

  it('a probe that throws withholds only its own word', () => {
    const caps = governanceCapabilities(wiring(() => { throw new Error('probe broke') }))
    expect(caps).not.toContain(CAP_PATH_GUARD)
    expect(caps).toContain(CAP_SEALED_GATES)
    expect(caps).toContain(CAP_CONTAINED)
  })

  it('the live wiring has no run context in the suite, so it does not say the word', () => {
    expect(governanceCapabilities()).not.toContain(CAP_PATH_GUARD)
  })

  it('the engine and the driver spell the word the same way', () => {
    expect(CAP_PATH_GUARD).toBe('path-guard')
    expect(CONTRACT_PATH_GUARD).toBe(CAP_PATH_GUARD)
  })
})

describe('containmentDispatchRefusal requires path-guard', () => {
  it('refuses an engine that says every other word, naming path-guard as absent', () => {
    for (const platform of ['win32', 'linux']) {
      const r = containmentDispatchRefusal({ capabilities: [CAP_CONTAINED, 'tool-audit'], platform })
      expect(typeof r).toBe('string')
      expect(r).toContain('this engine is not a contained mission engine')
      expect(r).toContain(`${CAP_PATH_GUARD} is absent`)
      expect(r).toContain('Nothing was dispatched.')
    }
  })

  it('dispatches once path-guard is added', () => {
    // With tool-audit (S5), which the refusal also requires.
    expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED, CAP_PATH_GUARD, 'tool-audit'], platform: 'win32' })).toBeNull()
    expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED, CAP_PATH_GUARD, 'tool-audit'], platform: 'linux' })).toBeNull()
  })
})

describe('source pins', () => {
  it('the boot block asks pathGuardFault after the context is set and before the model loads', () => {
    const main = read('engine/main.ts')
    const set = main.indexOf('setRunContainment(')
    const fault = main.indexOf('pathGuardFault()')
    const boot = main.indexOf('await bootstrapProvider(')
    expect(set).toBeGreaterThan(-1)
    expect(fault).toBeGreaterThan(set)
    expect(boot).toBeGreaterThan(fault)
  })

  it('toolPaths.ts imports nothing that imports the policy', () => {
    const src = read('engine/tools/toolPaths.ts')
    const imports = src.split('\n').filter(l => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l)).join('\n')
    for (const m of ['registry.js', 'executor.js', 'protectedPaths.js']) expect(imports).not.toContain(m)
  })

  it('nothing toolPaths.ts reaches, import by import, imports the policy, the registry or the executor (review 2026-11-23)', () => {
    // Until 2026-11-23 toolPaths -> impl/git -> impl/bash -> protectedPaths -> toolPaths was a cycle that the
    // direct-import pin above did not see.
    const seen = new Set<string>()
    const queue = ['engine/tools/toolPaths.ts']
    while (queue.length) {
      const file = queue.shift() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const m of read(file).matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?(?:\{[^}]*\}[^'"\n]*?)?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = join(dirname(file), m[1]).replace(/\\/g, '/').replace(/\.js$/, '.ts')
        queue.push(target)
      }
    }
    expect(seen.size).toBeGreaterThan(3)
    for (const f of ['engine/tools/protectedPaths.ts', 'engine/tools/registry.ts', 'engine/tools/executor.ts']) {
      expect([...seen], f).not.toContain(f)
    }
  })

  it('protectedPaths.ts and toolPaths.ts read no environment and no argv', () => {
    for (const f of ['engine/tools/protectedPaths.ts', 'engine/tools/toolPaths.ts']) {
      const src = read(f)
      expect(src, f).not.toContain('process.env')
      expect(src, f).not.toContain('process.argv')
    }
  })

  it("bashSafety.ts's environment rule is the line this work started from", () => {
    expect(read('engine/tools/bashSafety.ts')).toContain(
      "{ pattern: /(?<![\\w$:.])(?:env|printenv)\\b(?!:)/, reason: 'Commands that dump all environment variables are blocked — may expose secrets' },",
    )
  })
})
