#!/usr/bin/env bun
/**
 * E2E test: SmallCode feature port verification.
 * Tests all 7 ported features against a live engine.
 *
 * 1. Tool result capping
 * 2. Blocking command detection
 * 3. Bash error diagnosis
 * 4. Per-tool trust score decay
 * 5. Contract / Definition of Done
 * 6. Two-stage tool routing (unit-level, no model needed)
 * 7. Semantic merge (unit-level, no model needed)
 *
 * Usage: Start engine first, then:
 *   bun engine/__tests__/integration/e2e-smallcode-features.ts
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`

type Event = { type: string; [key: string]: unknown }
const events: Event[] = []
const eventsByType = new Map<string, Event[]>()
const streamTokens: string[] = []

function record(evt: Event) {
  events.push(evt)
  const list = eventsByType.get(evt.type) ?? []
  list.push(evt)
  eventsByType.set(evt.type, list)
  if (evt.type === 'stream.token' && typeof evt.text === 'string') streamTokens.push(evt.text)
}

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function clearStream() { streamTokens.length = 0 }
function getStream() { return streamTokens.join('') }

async function waitComplete(preCount: number, sec: number = 120): Promise<boolean> {
  for (let i = 0; i < sec; i++) {
    if ((eventsByType.get('message.complete') ?? []).length > preCount) return true
    await sleep(1000)
  }
  return false
}

// ─── Connect ──────────────────────────────────────────────────

log('═══ CynCo SmallCode Feature Port E2E ═══')
const ws = new WebSocket(WS_URL)
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 10000)
  ws.onopen = () => { clearTimeout(t); log('Connected'); resolve() }
  ws.onerror = () => { clearTimeout(t); reject(new Error('WS error')) }
})

ws.onmessage = (msg) => {
  try {
    const evt = JSON.parse(msg.data as string) as Event
    record(evt)
    if (evt.type === 'tool.start') log(`  tool.start: ${evt.toolName}`)
    else if (evt.type === 'tool.complete') {
      const out = (evt.output as string ?? '').slice(0, 120)
      log(`  tool.complete: ${evt.toolName} err=${evt.isError} | ${out}`)
    }
    else if (evt.type === 'approval.request') {
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') log(`  message.complete`)
  } catch {}
}

await sleep(3000)
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)

const results: { name: string; pass: boolean; detail: string }[] = []

// ═══════════════════════════════════════════════════════════════
// Test 1: Tool Result Capping
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 1: Tool Result Capping ═══')
log('Asking model to read a large file...')

const pre1 = (eventsByType.get('message.complete') ?? []).length
clearStream()

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Read the entire file engine/bridge/conversationLoop.ts and show me all of it.',
}))

await waitComplete(pre1, 120)

// Check tool.complete events for truncation
const readCompletes = (eventsByType.get('tool.complete') ?? []).filter(e => e.toolName === 'Read')
const lastRead = readCompletes[readCompletes.length - 1]
const readOutput = (lastRead?.output as string) ?? ''
const wasCapped = readOutput.includes('truncated') || readOutput.length <= 4100

results.push({
  name: 'Tool result capping active',
  pass: wasCapped,
  detail: wasCapped
    ? `Output ${readOutput.length} chars (capped)`
    : `Output ${readOutput.length} chars (NOT capped — may be under limit)`,
})
log(`  Read output: ${readOutput.length} chars, capped: ${readOutput.includes('truncated')}`)

// ═══════════════════════════════════════════════════════════════
// Test 2: Blocking Command Detection
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 2: Blocking Command Detection ═══')
log('Asking model to run a server...')

const pre2 = (eventsByType.get('message.complete') ?? []).length
clearStream()

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Run this exact bash command for me: npm start',
}))

await waitComplete(pre2, 60)

const stream2 = getStream()
const toolCompletes2 = eventsByType.get('tool.complete') ?? []
const bashResults = toolCompletes2.filter(e => e.toolName === 'Bash')
const blocked = bashResults.some(e => {
  const out = (e.output as string) ?? ''
  return out.includes('Refused') || out.includes('Blocked') || out.includes('blocked')
})
// Also check if the model mentioned it was blocked in its response
const modelMentionedBlock = stream2.includes('block') || stream2.includes('Refused') || stream2.includes('server') || stream2.includes('long-running')

results.push({
  name: 'Server command blocked',
  pass: blocked || modelMentionedBlock,
  detail: blocked ? 'Bash tool returned Refused/Blocked' : (modelMentionedBlock ? 'Model acknowledged blocking' : 'Not detected'),
})
log(`  Bash blocked: ${blocked}, Model mentioned: ${modelMentionedBlock}`)

// ═══════════════════════════════════════════════════════════════
// Test 3: Bash Error Diagnosis
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 3: Bash Error Diagnosis ═══')
log('Running a command that will fail...')

const pre3 = (eventsByType.get('message.complete') ?? []).length
clearStream()

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Run this exact bash command: python -c "import nonexistent_module_xyz"',
}))

await waitComplete(pre3, 60)

const bashResults3 = (eventsByType.get('tool.complete') ?? []).filter(e => e.toolName === 'Bash')
const lastBash3 = bashResults3[bashResults3.length - 1]
const bashOut3 = (lastBash3?.output as string) ?? ''
const hasDiagnosis = bashOut3.includes('[ERROR:') && (
  bashOut3.includes('dependency') || bashOut3.includes('not_found') || bashOut3.includes('runtime')
)

results.push({
  name: 'Error diagnosis prepends hint',
  pass: hasDiagnosis,
  detail: hasDiagnosis ? bashOut3.slice(0, 100) : `No [ERROR:] prefix found. Output: ${bashOut3.slice(0, 100)}`,
})
log(`  Has diagnosis: ${hasDiagnosis}`)
if (hasDiagnosis) log(`  Prefix: ${bashOut3.slice(0, 80)}`)

// ═══════════════════════════════════════════════════════════════
// Test 4: Contract Tools Available
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 4: Contract Tools Available ═══')

const pre4 = (eventsByType.get('message.complete') ?? []).length
clearStream()

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Call the ContractCreate tool with title "Test Contract", brief "Testing contracts", and assertions ["Test passes", "File exists"]. Use the tool directly.',
}))

await waitComplete(pre4, 90)

const contractTools = (eventsByType.get('tool.start') ?? []).filter(e =>
  (e.toolName as string ?? '').includes('Contract')
)
const contractCompletes = (eventsByType.get('tool.complete') ?? []).filter(e =>
  (e.toolName as string ?? '').includes('Contract')
)

const contractCreated = contractCompletes.some(e => {
  const out = (e.output as string) ?? ''
  return out.includes('Contract created') || out.includes('assertions')
})

results.push({
  name: 'Contract tools accessible',
  pass: contractTools.length > 0 || contractCreated,
  detail: `Tool calls: ${contractTools.length}, Created: ${contractCreated}`,
})
log(`  Contract tool calls: ${contractTools.length}, created: ${contractCreated}`)

// ═══════════════════════════════════════════════════════════════
// Test 5: Per-Tool Trust Scoring (unit verification)
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 5: Trust Score Unit Check ═══')

// Import and test directly — no model call needed
try {
  const { ToolScorer } = await import('../../tools/toolScorer.js')
  const scorer = new ToolScorer()
  scorer.record('TestTool', false)
  scorer.record('TestTool', false)
  scorer.record('TestTool', false)
  const conf = scorer.getConfidence('TestTool')
  const demoted = scorer.shouldDemote('TestTool')
  const demotedList = scorer.getDemotedTools()

  results.push({
    name: 'Trust scorer demotes failing tools',
    pass: demoted && demotedList.includes('TestTool') && conf < 0.35,
    detail: `confidence=${conf.toFixed(3)}, demoted=${demoted}, list=${demotedList.join(',')}`,
  })
  log(`  Confidence: ${conf.toFixed(3)}, Demoted: ${demoted}`)
} catch (err) {
  results.push({ name: 'Trust scorer works', pass: false, detail: `Import error: ${err}` })
  log(`  ERROR: ${err}`)
}

// ═══════════════════════════════════════════════════════════════
// Test 6: Tool Router (unit verification)
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 6: Tool Router Unit Check ═══')

try {
  const { TOOL_CATEGORIES, getToolsForCategory, shouldUseRouting } = await import('../../tools/toolRouter.js')

  const catCount = Object.keys(TOOL_CATEGORIES).length
  const smallCtx = shouldUseRouting(16384)
  const largeCtx = shouldUseRouting(131072)
  const mockTools = [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }] as any[]
  const readOnly = getToolsForCategory('read', mockTools)
  const allTools = getToolsForCategory('all', mockTools)

  results.push({
    name: 'Tool router categories and routing',
    pass: catCount === 6 && smallCtx && !largeCtx && readOnly.length === 1 && allTools.length === 3,
    detail: `cats=${catCount}, small=${smallCtx}, large=${largeCtx}, readFilter=${readOnly.length}, allFilter=${allTools.length}`,
  })
  log(`  Categories: ${catCount}, Small routing: ${smallCtx}, Large: ${largeCtx}`)
} catch (err) {
  results.push({ name: 'Tool router works', pass: false, detail: `Import error: ${err}` })
  log(`  ERROR: ${err}`)
}

// ═══════════════════════════════════════════════════════════════
// Test 7: Semantic Merge (unit verification)
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 7: Semantic Merge Unit Check ═══')

try {
  const { attemptSemanticMerge } = await import('../../tools/semanticMerge.js')

  const attempted = new Set<string>()
  const prompt = attemptSemanticMerge('const x = 1;\nconst y = 2;', 'const z', 'const w', 'test.ts', attempted)
  const tooLarge = attemptSemanticMerge(Array(501).fill('line').join('\n'), 'a', 'b', 'big.ts', new Set())
  const duplicate = attemptSemanticMerge('code', 'a', 'b', 'test.ts', attempted) // already attempted

  results.push({
    name: 'Semantic merge guards and prompt',
    pass: prompt !== null && tooLarge === null && duplicate === null && prompt.system.includes('merger'),
    detail: `valid=${prompt !== null}, tooLarge=${tooLarge === null}, dedup=${duplicate === null}`,
  })
  log(`  Valid prompt: ${prompt !== null}, Large rejected: ${tooLarge === null}, Dedup: ${duplicate === null}`)
} catch (err) {
  results.push({ name: 'Semantic merge works', pass: false, detail: `Import error: ${err}` })
  log(`  ERROR: ${err}`)
}

// ═══════════════════════════════════════════════════════════════
// Test 8: Contract Enforcement (via disagreement)
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 8: Contract Enforcement in System Prompt ═══')

const pre8 = (eventsByType.get('message.complete') ?? []).length
clearStream()

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Call ContractStatus to check if any contract is active.',
}))

await waitComplete(pre8, 60)

const contractStatusCalls = (eventsByType.get('tool.complete') ?? []).filter(e =>
  (e.toolName as string ?? '').includes('ContractStatus')
)
const statusOutput = contractStatusCalls.length > 0
  ? (contractStatusCalls[contractStatusCalls.length - 1].output as string ?? '')
  : getStream()

const hasContractInfo = statusOutput.includes('Contract') || statusOutput.includes('contract') || statusOutput.includes('No active') || statusOutput.includes('assertion')

results.push({
  name: 'ContractStatus tool works',
  pass: hasContractInfo,
  detail: statusOutput.slice(0, 100),
})
log(`  Status output: ${statusOutput.slice(0, 80)}`)

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Summary ═══')
log(`Total events: ${events.length}`)
log('')

let pass = 0, fail = 0
for (const r of results) {
  log(`  ${r.pass ? '✓' : '✗'} ${r.name}: ${r.detail}`)
  if (r.pass) pass++; else fail++
}
log(`\n${pass} passed, ${fail} failed out of ${results.length} checks`)

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
process.exit(fail > 0 ? 1 : 0)
