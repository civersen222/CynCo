import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ConfigPopulation, type PopulationConfig } from '../../vsm/population.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ConfigPopulation', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pop-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('initializes population from baseline params', () => {
    const baseline = { 'variety.env_multiplier': 8.0, 'homeostat.damping': 0.5 }
    const pop = ConfigPopulation.initialize(dir, baseline, 10)
    expect(pop.size()).toBe(10)
    const c0 = pop.getConfig(0)
    expect(c0.params['variety.env_multiplier']).toBe(8.0)
    expect(c0.params['homeostat.damping']).toBe(0.5)
    const c5 = pop.getConfig(5)
    const differs = Object.keys(baseline).some(k => c5.params[k] !== baseline[k])
    expect(differs).toBe(true)
  })

  it('loads population from disk', () => {
    const baseline = { 'variety.env_multiplier': 8.0 }
    ConfigPopulation.initialize(dir, baseline, 5)
    const pop = ConfigPopulation.load(dir)
    expect(pop.size()).toBe(5)
  })

  it('selects from viable configs', () => {
    const baseline = { 'variety.env_multiplier': 8.0 }
    const pop = ConfigPopulation.initialize(dir, baseline, 5)
    pop.markViable(0)
    pop.markViable(1)
    pop.markViable(2)
    // Run multiple selections — most should be viable (indices 0-2),
    // but 20% exploration rate can pick any config
    let viableCount = 0
    const runs = 50
    for (let i = 0; i < runs; i++) {
      const selected = pop.selectViable()
      if (selected.index <= 2) viableCount++
    }
    // With 80% viable selection + 20% exploration (3/5 chance of viable in exploration),
    // expected viable rate is ~92%. Allow generous margin.
    expect(viableCount).toBeGreaterThan(runs * 0.5)
  })

  it('selects randomly when no configs are viable', () => {
    const baseline = { 'variety.env_multiplier': 8.0 }
    const pop = ConfigPopulation.initialize(dir, baseline, 5)
    const selected = pop.selectViable()
    expect(selected.index).toBeGreaterThanOrEqual(0)
    expect(selected.index).toBeLessThan(5)
  })

  it('perturbs a config with given magnitude', () => {
    const baseline = { 'variety.env_multiplier': 8.0, 'homeostat.damping': 0.5 }
    const pop = ConfigPopulation.initialize(dir, baseline, 5)
    const before = { ...pop.getConfig(0).params }
    pop.perturbConfig(0, 0.5)
    const after = pop.getConfig(0).params
    const changed = Object.keys(before).some(k => before[k] !== after[k])
    expect(changed).toBe(true)
  })

  it('maintains variety — perturbs one config when population converges', () => {
    const baseline = { 'variety.env_multiplier': 8.0 }
    const pop = ConfigPopulation.initialize(dir, baseline, 5)
    for (let i = 0; i < 5; i++) {
      pop.getConfig(i).params = { ...baseline }
    }
    pop.maintainVariety(0)
    let foundDifferent = false
    for (let i = 1; i < 5; i++) {
      if (pop.getConfig(i).params['variety.env_multiplier'] !== 8.0) {
        foundDifferent = true
        break
      }
    }
    expect(foundDifferent).toBe(true)
  })

  it('saves state to disk after updates', () => {
    const baseline = { 'variety.env_multiplier': 8.0 }
    const pop = ConfigPopulation.initialize(dir, baseline, 3)
    pop.markViable(0)
    pop.save()
    expect(existsSync(join(dir, 'config_00.json'))).toBe(true)
    const data = JSON.parse(readFileSync(join(dir, 'config_00.json'), 'utf-8'))
    expect(data.viable).toBe(true)
  })
})
