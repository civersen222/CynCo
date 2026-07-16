import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

/** Engine event types the TUI intentionally does NOT parse. Every entry needs a reason. */
const NON_TUI_CONSUMERS: Record<string, string> = {
  'governance.session_fidelity': 'consumed by the mission driver, not the TUI',
}

/** TUI event types handled bespoke in the receiver (app.py), not via the dispatch table. */
const BESPOKE_TUI_HANDLERS = ['session.ready', 'session.error']

function engineEventTypes(): string[] {
  const src = readFileSync(join(repoRoot, 'engine', 'bridge', 'protocol.ts'), 'utf-8')
  // The EngineEvent union ends with a blank line (\n\n) before the TUI→Engine Commands section.
  // Adapted: protocol.ts uses CRLF line endings on Windows. The blank line
  // after the last union member is \r\n\r\n, so \n\n alone does not match.
  // Use \r?\n\r?\n to handle both LF and CRLF repos.
  const unionMatch = src.match(/export type EngineEvent =([\s\S]*?)\r?\n\r?\n/)
  if (!unionMatch) throw new Error('EngineEvent union not found in protocol.ts')
  const members = [...unionMatch[1].matchAll(/\|\s*(\w+)/g)].map(m => m[1])
  if (members.length === 0) throw new Error('EngineEvent union parsed zero members — regex likely broken')
  return members.map(name => {
    // Each event type is defined as: export type Foo = {\n  type: 'literal'
    const def = src.match(new RegExp(`export type ${name} = \\{\\s*\\n\\s*type: '([^']+)'`))
    if (!def) throw new Error(`No literal type found for EngineEvent member ${name}`)
    return def[1]
  })
}

function tuiEventEntries(): Record<string, string> {
  const src = readFileSync(join(repoRoot, 'tui', 'localcode_tui', 'protocol.py'), 'utf-8')
  // EVENT_TYPES dict values are bare class names (no nested braces), so non-greedy \} is safe.
  const dictMatch = src.match(/EVENT_TYPES = \{([\s\S]*?)\}/)
  if (!dictMatch) throw new Error('EVENT_TYPES dict not found in protocol.py')
  const map: Record<string, string> = {}
  for (const m of dictMatch[1].matchAll(/"([a-z0-9._]+)":\s*(\w+)/g)) map[m[1]] = m[2]
  if (Object.keys(map).length === 0) throw new Error('EVENT_TYPES parsed zero entries — regex likely broken')
  return map
}

function tuiDispatchedClasses(): Set<string> {
  const src = readFileSync(join(repoRoot, 'tui', 'localcode_tui', 'app.py'), 'utf-8')
  // _event_dispatch_table closing brace is indented 8 spaces (2× 4-space indent).
  // The regex captures everything between "return {" and the closing "        }".
  const tableMatch = src.match(/def _event_dispatch_table[\s\S]*?return \{([\s\S]*?)\n        \}/)
  if (!tableMatch) throw new Error('_event_dispatch_table not found in app.py')
  return new Set([...tableMatch[1].matchAll(/(\w+Event):/g)].map(m => m[1]))
}

describe('protocol coverage guard (engine <-> TUI)', () => {
  it('parsers actually find the protocol surfaces', () => {
    const engineTypes = engineEventTypes()
    const tuiEntries = tuiEventEntries()
    expect(
      engineTypes.length,
      `engineEventTypes() returned only ${engineTypes.length} types — the union regex is broken`
    ).toBeGreaterThanOrEqual(10)
    expect(
      Object.keys(tuiEntries).length,
      `tuiEventEntries() returned only ${Object.keys(tuiEntries).length} entries — the EVENT_TYPES regex is broken`
    ).toBeGreaterThanOrEqual(10)
    const dispatched = tuiDispatchedClasses()
    expect(
      dispatched.size,
      `tuiDispatchedClasses() returned only ${dispatched.size} classes — the dispatch table regex is broken`
    ).toBeGreaterThanOrEqual(5)
  })

  it('every EngineEvent type is parsed by the TUI or explicitly allowlisted', () => {
    const tui = new Set(Object.keys(tuiEventEntries()))
    const missing = engineEventTypes().filter(t => !tui.has(t) && !(t in NON_TUI_CONSUMERS))
    expect(missing, `Engine emits event types the TUI cannot parse: ${missing.join(', ')}. ` +
      'Add a dataclass + EVENT_TYPES entry + dispatch handler in the TUI, or allowlist with a reason.').toEqual([])
  })

  it('every TUI EVENT_TYPES entry corresponds to a real engine event (no dead TUI types)', () => {
    const engine = new Set(engineEventTypes())
    const dead = Object.keys(tuiEventEntries()).filter(t => !engine.has(t))
    expect(dead, `TUI parses event types the engine never defines: ${dead.join(', ')}`).toEqual([])
  })

  it('every TUI-parsed event has a dispatch handler in app.py (or is bespoke)', () => {
    const dispatched = tuiDispatchedClasses()
    const unhandled = Object.entries(tuiEventEntries())
      .filter(([t, cls]) => !dispatched.has(cls) && !BESPOKE_TUI_HANDLERS.includes(t))
      .map(([t]) => t)
    expect(unhandled, `TUI parses but never handles: ${unhandled.join(', ')}. ` +
      'Add the class to _event_dispatch_table in app.py.').toEqual([])
  })
})
