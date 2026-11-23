/**
 * F242: the driver dispatches a mission only to an engine that says its tools are contained.
 *
 * Shaped like F41 and F59: the engine advertises a word for the SAFE state (`contained-tools`, or
 * `contained-overlay` where there is no kernel layer) and the driver refuses on its absence, so an
 * engine too old to say the word, or one that booted without a sandbox, can never read as contained.
 * The word is measured from the run context the boot block set (`runContainment()`), never from an
 * environment variable or a message flag.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAP_CONTAINED, CAP_CONTAINED_OVERLAY, CAP_S5_ADVISORY, CAP_HOUSE_CONDUCT, governanceCapabilities } from '../../bridge/capabilities.js'
import { DISPATCH_RUN_PREFIX, setRunContainment, testContainment } from '../../containment.js'
// @ts-ignore — untyped harness module
import { containmentDispatchRefusal, CAP_CONTAINED as CONTRACT_CONTAINED, CAP_CONTAINED_OVERLAY as CONTRACT_OVERLAY } from '../../../scripts/cynco-contract.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

const base = { seal: () => {}, probe: () => false, unseal: () => {}, s5Enforcing: () => false }

describe('the contained-tools word', () => {
  it('verified says contained-tools and not contained-overlay', () => {
    const caps = governanceCapabilities({ ...base, contained: () => 'verified' })
    expect(caps).toContain(CAP_CONTAINED)
    expect(caps).not.toContain(CAP_CONTAINED_OVERLAY)
  })

  it('overlay says contained-overlay and not contained-tools', () => {
    const caps = governanceCapabilities({ ...base, contained: () => 'overlay' })
    expect(caps).toContain(CAP_CONTAINED_OVERLAY)
    expect(caps).not.toContain(CAP_CONTAINED)
  })

  it('null, an absent member or a throw says neither, and a throw removes no other word', () => {
    for (const wiring of [{ ...base, contained: () => null }, base]) {
      const caps = governanceCapabilities(wiring)
      expect(caps).not.toContain(CAP_CONTAINED)
      expect(caps).not.toContain(CAP_CONTAINED_OVERLAY)
    }
    const caps = governanceCapabilities({ ...base, houseConduct: () => true, contained: () => { throw new Error('boom') } })
    expect(caps).not.toContain(CAP_CONTAINED)
    expect(caps).not.toContain(CAP_CONTAINED_OVERLAY)
    expect(caps).toContain(CAP_S5_ADVISORY)
    expect(caps).toContain(CAP_HOUSE_CONDUCT)
  })

  describe('LIVE reads the run context', () => {
    afterEach(() => setRunContainment(null))

    it('a test context never claims either word, and no context claims neither', () => {
      expect(governanceCapabilities()).not.toContain(CAP_CONTAINED)
      expect(governanceCapabilities()).not.toContain(CAP_CONTAINED_OVERLAY)
      // testContainment touches no disk, so the folders are names only.
      const dir = join(tmpdir(), 'cynco-capability-never-created')
      const sb = join(dir, 'sandbox', 'run')
      setRunContainment(testContainment({
        missionCwd: join(dir, 'mission'),
        sandbox: { root: sb, home: join(sb, 'home'), tmp: join(sb, 'tmp'), scratch: join(sb, 'scratch') },
        home: join(dir, 'home'),
        folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
        isolation: 'verified',
      }))
      const caps = governanceCapabilities()
      expect(caps).not.toContain(CAP_CONTAINED)
      expect(caps).not.toContain(CAP_CONTAINED_OVERLAY)
    })
  })

  it('the engine and the driver spell the two words the same', () => {
    expect(CONTRACT_CONTAINED).toBe(CAP_CONTAINED)
    expect(CONTRACT_OVERLAY).toBe(CAP_CONTAINED_OVERLAY)
  })
})

describe('containmentDispatchRefusal', () => {
  it('dispatches to contained-tools on Windows and to contained-overlay elsewhere', () => {
    expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED], platform: 'win32' })).toBeNull()
    expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED_OVERLAY], platform: 'linux' })).toBeNull()
    expect(containmentDispatchRefusal({ capabilities: [CAP_CONTAINED], platform: 'linux' })).toBeNull()
  })

  it('refuses everything else, naming the missing word', () => {
    const cases: Array<[unknown, string]> = [
      [[CAP_CONTAINED_OVERLAY], 'win32'], [[], 'win32'], [['s5-advisory'], 'win32'], [null, 'win32'], [undefined, 'win32'],
      [[], 'linux'], [null, 'linux'],
    ]
    for (const [capabilities, platform] of cases) {
      const r = containmentDispatchRefusal({ capabilities, platform })
      expect(typeof r, `${JSON.stringify(capabilities)} on ${platform}`).toBe('string')
      expect(r).toContain('this engine is not a contained mission engine')
      expect(r).toContain(CAP_CONTAINED)
      expect(r).toContain('Nothing was dispatched.')
      if (platform === 'linux') expect(r).toContain(`${CAP_CONTAINED} or ${CAP_CONTAINED_OVERLAY}`)
      if (Array.isArray(capabilities)) expect(r).toContain(`the engine advertised [${capabilities.join(', ')}]`)
      else expect(r).toContain('the engine advertised no capabilities at all')
    }
  })
})

describe('where the word and the sandbox are wired', () => {
  const driver = read('scripts/cynco-mission-driver.mjs')
  const block = (text: string, from: string, to: string) => {
    const start = text.indexOf(from)
    expect(start).toBeGreaterThan(-1)
    const end = text.indexOf(to, start)
    expect(end).toBeGreaterThan(start)
    return text.slice(start, end)
  }

  it('the driver asks for the word when the engine answers', () => {
    expect(block(driver, "if (m.type === 'session.ready'", 'dispatchMission()')).toContain('containmentDispatchRefusal(')
  })

  it('the driver asks for the word when the engine never answers', () => {
    expect(block(driver, 'const readyGateTimer', 'ws.onopen')).toContain('containmentDispatchRefusal(')
  })

  it('the driver adopts the sandbox before it does anything else with the mission folder', () => {
    const adopt = driver.indexOf('adoptContainment(')
    expect(adopt).toBeGreaterThan(driver.indexOf('const cwdError = workspaceError(CWD)'))
    expect(adopt).toBeLessThan(driver.indexOf('const TIMEOUT_S'))
  })

  it('the engine adopts after the task file is read and the job is installed, before the model loads', () => {
    const main = read('engine/main.ts')
    const adopt = main.indexOf('adoptContainment(')
    expect(adopt).toBeGreaterThan(-1)
    expect(adopt).toBeGreaterThan(main.indexOf('readTaskFile(p)'))
    expect(adopt).toBeGreaterThan(main.indexOf('installKillOnCloseJob()'))
    expect(adopt).toBeLessThan(main.indexOf('await bootstrapProvider('))
  })

  it("dispatch-mission.sh prints the run line the campaign runner reads", () => {
    const sh = read('scripts/dispatch-mission.sh')
    const line = sh.split(/\r?\n/).find(l => /^echo "\[dispatch\] run \$RUN_ID"$/.test(l.trim()))
    expect(line).toBeDefined()
    expect(line!.trim()).toBe(`echo "${DISPATCH_RUN_PREFIX}$RUN_ID"`)
  })
})
