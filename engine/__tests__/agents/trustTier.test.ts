/**
 * What a sub-agent may use, by trust tier (owner's decision sheet of 2026-11-17, row 22).
 *
 * `makeSubAgentConfig` has listed WebSearch and WebFetch for the specialist tier since the
 * researcher persona was added, and `getToolsForTier`, which is what the runner asks, returned
 * the read-only set for every tier: the researcher was told to gather sources and could not
 * reach one. What the runner offers is now what the config names, where the run that started
 * the agent could have used those tools itself.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getToolsForTier, type ParentToolAuthority } from '../../agents/trustTier.js'
import { makeSubAgentConfig } from '../../agents/types.js'

const names = (tools: Array<{ name: string }>) => tools.map(t => t.name).sort()
const READ_ONLY = ['CodeIndex', 'Git', 'Glob', 'Grep', 'ImageView', 'Ls', 'Read']
/** A run with no pin whose executor asks about nothing: an ordinary chat. */
const FREE: ParentToolAuthority = { pin: null, runsUnasked: () => true }

describe('sub-agent tools by trust tier', () => {
  it('a read-only agent gets the read-only tools and nothing that leaves the machine', () => {
    expect(names(getToolsForTier('readonly', 'scout', FREE))).toEqual(READ_ONLY)
  })

  it('the researcher (specialist) also searches and reads the web', () => {
    expect(names(getToolsForTier('specialist', 'researcher', FREE))).toEqual([...READ_ONLY, 'WebFetch', 'WebSearch'].sort())
  })

  it('what the runner offers is what the config says, for the tiers that are built', () => {
    for (const [tier, persona] of [['readonly', 'scout'], ['specialist', 'researcher']] as const) {
      const config = makeSubAgentConfig({ task: 't', persona, trustTier: tier })
      expect(names(getToolsForTier(tier, persona, FREE))).toEqual([...config.policyConstraints.allowedTools].sort())
    }
  })

  it('no tier writes or runs commands: the full tier is not built and stays read-only', () => {
    expect(names(getToolsForTier('full', 'kraken', FREE))).toEqual(READ_ONLY)
  })
})

describe('a sub-agent never gets more of the web than the run that started it', () => {
  // A sub-agent approves its own calls (it has nobody to ask), so a tool it is handed must be
  // one its parent could have used unasked.
  it('a run pinned to a tool list hands on only the web tools in its pin', () => {
    const parent = { pin: ['SubAgent', 'Read', 'WebSearch'], runsUnasked: () => true }
    expect(names(getToolsForTier('specialist', 'researcher', parent))).toEqual([...READ_ONLY, 'WebSearch'].sort())
  })

  it('a tool the parent would have to ask the user about is not handed on', () => {
    const parent = { pin: null, runsUnasked: (name: string) => name !== 'WebFetch' }
    expect(names(getToolsForTier('specialist', 'researcher', parent))).toEqual([...READ_ONLY, 'WebSearch'].sort())
  })

  it('with nobody vouching, the researcher has no web: a caller that forgets fails closed', () => {
    expect(names(getToolsForTier('specialist', 'researcher'))).toEqual(READ_ONLY)
  })

  it('the read-only tools are what they were, whatever the parent is pinned to', () => {
    const parent = { pin: ['SubAgent'], runsUnasked: () => false }
    expect(names(getToolsForTier('specialist', 'researcher', parent))).toEqual(READ_ONLY)
    expect(names(getToolsForTier('readonly', 'scout', parent))).toEqual(READ_ONLY)
    expect(names(getToolsForTier('readonly', 'scout'))).toEqual(READ_ONLY)
  })
})

describe('the loop hands its own limits to the sub-agents it starts (wiring, by text)', () => {
  it('the SubAgent interception passes the run pin and the executor check', () => {
    const src = readFileSync(join(process.cwd(), 'engine', 'bridge', 'conversationLoop.ts'), 'utf-8')
    const at = src.indexOf('SubAgent interception')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 3000)).toContain('parent: { pin: this.allowedTools, runsUnasked: name => this.executor.runsUnasked(name) }')
  })
})
