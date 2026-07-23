import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ALL_TOOLS } from '../../tools/registry.js'

// BLOCKING wire-check (per CLAUDE.md): every new skill symbol must be imported
// AND called on a live (non-test) path. We assert against the actual source of
// the wiring sites so a future refactor that silently drops a call fails here.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('skill system wiring guard', () => {
  it('run_skill and list_skills are in the registry as core tools', () => {
    const run = ALL_TOOLS.find(t => t.name === 'run_skill')
    const list = ALL_TOOLS.find(t => t.name === 'list_skills')
    expect(run?.core).toBe(true)
    expect(list?.core).toBe(true)
  })

  it('conversationLoop discovers skills and surfaces run_skill tools on a live path', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toContain("from '../skills/loader.js'")
    expect(src).toContain("from '../skills/store.js'")
    expect(src).toContain("from '../skills/prompt.js'")
    // Discovery is actually invoked, not just imported.
    expect(src).toContain('loadSkills({ knownTools })')
    expect(src).toContain('setLoadedSkills(skills)')
    expect(src).toContain('this.ensureSkillsLoaded()')
    // run_skill surfaces the skill's declared tools through the load channel.
    expect(src).toContain("block.name === 'run_skill'")
    expect(src).toContain('getSkillByName(block.input.name)')
    // The skill-index block enters the prompt.
    expect(src).toContain('formatSkillIndexBlock(getSkillIndex())')
  })

  it('main.ts wires the /skill slash command to scaffold + install', () => {
    const src = read('engine/main.ts')
    expect(src).toContain("case '/skill'")
    expect(src).toContain("import('./skills/scaffold.js')")
    expect(src).toContain("import('./skills/install.js')")
    expect(src).toContain('scaffoldSkill(name)')
    expect(src).toContain('installSkill(spec,')
    // Emits the protocol events the TUI parses.
    expect(src).toContain("type: 'skill.status'")
    expect(src).toContain("type: 'skill.installed'")
    expect(src).toContain("type: 'skill.list'")
  })

  it('the skill meta-tools read the store via dynamic import (no cycle)', () => {
    const src = read('engine/tools/impl/skillTools.ts')
    expect(src).toContain("await import('../../skills/store.js')")
    expect(src).toContain("await import('../../skills/loader.js')")
    expect(src).toContain('getSkillByName')
    expect(src).toContain('getSkillIndex')
    expect(src).toContain('readSkillBody')
  })
})
