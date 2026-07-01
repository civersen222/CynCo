/**
 * Live end-to-end verification of the grounding gate.
 *
 * Drives a REAL ConversationLoop (the production class, not a re-implementation)
 * against a temp copy of the REAL CivKings repo, with a scripted provider that
 * emits a known concept-collision edit. Proves, against the live code path:
 *
 *   1. The gate BLOCKS an ungrounded edit (`self.happiness` plain field) once
 *      governance intensity reaches 2 (difficulty 'hard').
 *   2. The block surfaces the corrective grounding message as a tool error.
 *   3. A later GROUNDED edit to the SAME file (`self.happiness_system...`) is
 *      resolved as a SUCCESS — proving the C1 fix (resolution runs ungated) and
 *      the C2 fix (resolution is scoped to the right file+concept).
 *   4. The S5 decision journal records an honest (fire -> pending, resolution ->
 *      grounded) training triple (M2 fix).
 *
 * Hermetic: HOME/USERPROFILE and the journal/rates dir are redirected to a temp
 * dir so the run never touches the user's real ~/.cynco state.
 *
 * Run:  bun benchmark/true/grounding/liveFire.ts
 */
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const CIVKINGS = 'C:/Users/civer/civkings'

// ── Hermetic environment: redirect home BEFORE importing engine modules so
//    os.homedir() (rates persistence) resolves into the temp sandbox.
const sandbox = mkdtempSync(join(tmpdir(), 'grounding-live-'))
const fakeHome = join(sandbox, 'home')
const trainingDir = join(fakeHome, '.cynco', 'training')
mkdirSync(trainingDir, { recursive: true })
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome
process.env.LOCALCODE_MODEL = 'test'

const { ConversationLoop } = await import('../../../engine/bridge/conversationLoop.js')
const { S5Orchestrator } = await import('../../../engine/s5/orchestrator.js')
const { RuleBasedS5 } = await import('../../../engine/s5/ruleBasedS5.js')
const { initJournal, getJournal } = await import('../../../engine/training/decisionJournal.js')
import type { Provider, ModelCapabilities, CompletionRequest } from '../../../engine/provider.js'
import type { StreamEvent } from '../../../engine/types.js'

// ── Copy the real CivKings .py files into an isolated cwd.
const cwd = join(sandbox, 'civkings')
mkdirSync(cwd, { recursive: true })
let copied = 0
for (const f of readdirSync(CIVKINGS)) {
  if (f.endsWith('.py')) { copyFileSync(join(CIVKINGS, f), join(cwd, f)); copied++ }
}
console.log(`[setup] copied ${copied} .py files from real CivKings into ${cwd}`)

// ── Journal -> temp training dir so we can read back the S5 triple.
initJournal(trainingDir)

// ── Scripted provider. Each generator is one assistant turn.
function caps(): ModelCapabilities {
  return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 131072, streaming: true }
}
function* text(t: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm', model: 'test', usage: { input_tokens: 5, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } as any
  yield { type: 'message_stop' } as any
}
function* toolCall(name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm', model: 'test', usage: { input_tokens: 5, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-' + Math.random().toString(36).slice(2), name, input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

const cityPath = join(cwd, 'city.py')
const turns: Array<() => Generator<StreamEvent>> = [
  // 1. Errored Read -> a single tool error escalates difficulty to 'hard' (intensity 2).
  () => toolCall('Read', { file_path: join(cwd, 'does-not-exist.py') }),
  // 2. UNGROUNDED edit: reads the "happiness" concept from the plain self.happiness
  //    field instead of the authoritative happiness_system. Gate should BLOCK.
  //    Kept to a single concept (no other multi-source words like "stability").
  () => toolCall('Edit', {
    file_path: cityPath,
    old_string: 'self.happiness = 0',
    new_string: 'prod_loss = self.happiness * 0.5  # scale by happiness',
  }),
  // 3. GROUNDED edit to the SAME file re-addressing "happiness" (standalone word,
  //    so resolution fires) via the *_system source of truth -> resolution should
  //    record SUCCESS for the prior fire.
  () => toolCall('Edit', {
    file_path: cityPath,
    old_string: 'self.happiness = 0',
    new_string: 'prod_loss = self.happiness_system.current_happiness  # happiness from authoritative system',
  }),
  // 4. Wrap up.
  () => text('done'),
]

let idx = 0
const provider: Provider = {
  name: 'scripted',
  async healthCheck() { return true },
  async listModels() { return [] },
  async probeCapabilities() { return caps() },
  async complete() { throw new Error('not used') },
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const g = turns[idx++]
    if (g) yield* g()
  },
}

// ── Capture engine events to inspect what the gate did.
const events: any[] = []
const s5 = new S5Orchestrator(new RuleBasedS5())
const loop = new ConversationLoop({
  config: {
    baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined,
    noScouts: true, approveAll: true,
  } as any,
  provider,
  emit: (e) => events.push(e),
  cwd,
  s5,
})

const timer = setTimeout(() => { console.error('[live] TIMEOUT'); loop.abort() }, 60000)
await loop.handleUserMessage('Adjust the happiness contribution to city stability.')
clearTimeout(timer)

// ── Inspect outcomes.
const blockEvt = events.find(
  (e) => e.type === 'tool.complete' && e.isError && typeof e.result === 'string' && e.result.includes('BLOCKED by the grounding check'),
)
const s5File = join(trainingDir, 's5-decisions.jsonl')
const s5Lines = existsSync(s5File) ? readFileSync(s5File, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const fireRec = s5Lines.find((r) => r.input?.trigger === 'grounding' && r.input?.phase === 'fire')
const resolveRec = s5Lines.find((r) => r.input?.trigger === 'grounding' && r.input?.phase === 'resolution')
const ratesFile = join(trainingDir, 'intervention-rates.json')
const rates = existsSync(ratesFile) ? JSON.parse(readFileSync(ratesFile, 'utf-8')) : {}

const checks: Array<[string, boolean, string]> = [
  ['gate BLOCKED the ungrounded edit', !!blockEvt, blockEvt ? blockEvt.result.split('\n')[0] : 'no block event emitted'],
  ['block named the "happiness" concept', !!blockEvt && blockEvt.result.includes('happiness'), ''],
  ['block pointed at happiness_system source', !!blockEvt && blockEvt.result.includes('happiness_system'), ''],
  ['S5 fire logged (outcome pending)', !!fireRec && fireRec.outcome?.resolved === 'pending', JSON.stringify(fireRec?.outcome)],
  ['S5 resolution logged grounded=true', !!resolveRec && resolveRec.outcome?.grounded === true, JSON.stringify(resolveRec?.outcome)],
  ['rates persisted a grounding success', rates.grounding?.success >= 1 && rates.grounding?.total >= 1, JSON.stringify(rates.grounding)],
]

console.log('\n──────── S5 journal records ────────')
for (const r of s5Lines) console.log('  ' + JSON.stringify({ phase: r.input?.phase, toolName: r.input?.toolName, concept: r.input?.concept, concepts: r.input?.concepts, decision: r.decision, outcome: r.outcome }))
console.log('  rates: ' + JSON.stringify(rates))

console.log('\n──────── grounding live-fire results ────────')
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const allPass = checks.every(([, ok]) => ok)
console.log(`\n${allPass ? 'ALL PASS — grounding gate fires, blocks, and self-resolves live.' : 'FAILURES above.'}`)
console.log(`S5 journal lines: ${s5Lines.length}; events captured: ${events.length}`)
process.exit(allPass ? 0 : 1)
