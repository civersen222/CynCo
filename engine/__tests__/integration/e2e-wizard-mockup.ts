#!/usr/bin/env bun
/**
 * E2E test: Wizard mockup flow.
 * Tests: research → brainstorm → design → auto-mockup generation.
 *
 * Usage: Start engine first, then:
 *   bun engine/__tests__/integration/e2e-wizard-mockup.ts
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`

type Event = { type: string; [key: string]: unknown }
const events: Event[] = []
const eventsByType = new Map<string, Event[]>()

function record(evt: Event) {
  events.push(evt)
  const list = eventsByType.get(evt.type) ?? []
  list.push(evt)
  eventsByType.set(evt.type, list)
}

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Connect ──────────────────────────────────────────────────

log('═══ CynCo Wizard Mockup E2E Test ═══')
log(`Connecting to ${WS_URL}...`)

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
    if (evt.type === 'wizard.response') log(`  wizard.response: ${(evt.text as string ?? '').slice(0, 80)}...`)
    else if (evt.type === 'web.search.result') log(`  web.search.result: ${(evt.results as string ?? '').length} chars`)
    else if (evt.type === 'approval.request') {
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
  } catch {}
}

await sleep(3000) // wait for session.ready

const results: { name: string; pass: boolean; detail: string }[] = []

// ═══════════════════════════════════════════════════════════════
// Test 1: Web search via research engine
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 1: Research engine (web.search) ═══')

const searchPromise = new Promise<Event | null>((resolve) => {
  const check = setInterval(() => {
    const results = eventsByType.get('web.search.result')
    if (results && results.length > 0) { clearInterval(check); resolve(results[0]) }
  }, 500)
  setTimeout(() => { clearInterval(check); resolve(null) }, 60000)
})

ws.send(JSON.stringify({
  type: 'web.search',
  requestId: 'test-research-1',
  queries: ['todo list app best practices', 'task management UI design'],
}))

const searchEvt = await searchPromise
if (searchEvt) {
  const text = (searchEvt.results as string) ?? ''
  results.push({ name: 'Research returns results', pass: text.length > 50, detail: `${text.length} chars` })
  log(`  Result: ${text.length} chars`)
} else {
  results.push({ name: 'Research returns results', pass: false, detail: 'Timeout' })
  log('  TIMEOUT')
}

// ═══════════════════════════════════════════════════════════════
// Test 2: Wizard query — design synthesis
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 2: Design synthesis via wizard.query ═══')

const designPromise = new Promise<Event | null>((resolve) => {
  const check = setInterval(() => {
    const resps = eventsByType.get('wizard.response')
    if (resps) {
      const design = resps.find(e => (e as any).requestId === 'test-design-1')
      if (design) { clearInterval(check); resolve(design) }
    }
  }, 500)
  setTimeout(() => { clearInterval(check); resolve(null) }, 180000)
})

ws.send(JSON.stringify({
  type: 'wizard.query',
  requestId: 'test-design-1',
  systemPrompt: 'You are a product designer. Write a brief feature list (5-8 bullets) for the described app. Be concise.',
  prompt: 'A simple todo list app with categories, due dates, and priority levels.',
}))

log('  Waiting for design response (may take 1-2 min)...')
const designEvt = await designPromise
let designText = ''
if (designEvt) {
  designText = (designEvt.text as string) ?? ''
  results.push({ name: 'Design synthesis works', pass: designText.length > 100, detail: `${designText.length} chars` })
  log(`  Design: ${designText.length} chars`)
} else {
  results.push({ name: 'Design synthesis works', pass: false, detail: 'Timeout' })
  log('  TIMEOUT')
}

// ═══════════════════════════════════════════════════════════════
// Test 3: Mockup generation (the main test)
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 3: Mockup generation via wizard.query ═══')

if (designText.length < 50) {
  designText = '- Add/edit/delete todos\n- Categories (work, personal)\n- Due dates with calendar\n- Priority levels (high/medium/low)\n- Search and filter'
}

const mockupPromise = new Promise<Event | null>((resolve) => {
  const check = setInterval(() => {
    const resps = eventsByType.get('wizard.response')
    if (resps) {
      const mockup = resps.find(e => (e as any).requestId === 'test-mockup-1')
      if (mockup) { clearInterval(check); resolve(mockup) }
    }
  }, 500)
  setTimeout(() => { clearInterval(check); resolve(null) }, 300000) // 5 min timeout
})

ws.send(JSON.stringify({
  type: 'wizard.query',
  requestId: 'test-mockup-1',
  systemPrompt: 'You are a UI/UX designer creating a SIMPLE HTML wireframe. Generate a SHORT, self-contained HTML file showing the main screen layout.\n\nRequirements:\n- Single HTML file, inline CSS only, NO JavaScript\n- Use colored divs and borders to show layout regions (header, sidebar, main, footer)\n- Label each region with what it contains\n- Dark background (#1e1e1e), light text (#e0e0e0), colored borders for regions\n- Keep it UNDER 200 lines of HTML — this is a wireframe, not a finished product\n- Banner at top: \'LocalCode Design Preview\'\n\nReturn ONLY the HTML. No markdown, no explanation, no code fences. Just the raw HTML starting with <!DOCTYPE html>.',
  prompt: `Design to visualize:\n${designText}`,
}))

log('  Waiting for mockup response (may take 1-3 min)...')
const mockupEvt = await mockupPromise
if (mockupEvt) {
  let html = ((mockupEvt.text as string) ?? '').trim()
  const error = (mockupEvt as any).error

  if (error) {
    results.push({ name: 'Mockup generates without error', pass: false, detail: `Error: ${error}` })
    log(`  ERROR: ${error}`)
  } else if (html.length < 50) {
    results.push({ name: 'Mockup generates HTML', pass: false, detail: `Too short: ${html.length} chars` })
    log(`  Too short: ${html.length} chars`)
  } else {
    // Strip markdown fences if present
    if (html.startsWith('```')) {
      const lines = html.split('\n')
      html = lines.slice(1, lines[lines.length - 1].trim() === '```' ? -1 : undefined).join('\n')
    }

    const hasDoctype = html.includes('<!DOCTYPE') || html.includes('<html')
    const hasStyle = html.includes('<style') || html.includes('style=')
    const lineCount = html.split('\n').length

    results.push({ name: 'Mockup generates HTML', pass: hasDoctype, detail: `${html.length} chars, ${lineCount} lines, doctype=${hasDoctype}` })
    results.push({ name: 'Mockup has styling', pass: hasStyle, detail: hasStyle ? 'Has CSS' : 'No CSS found' })
    results.push({ name: 'Mockup is concise (<300 lines)', pass: lineCount < 300, detail: `${lineCount} lines` })

    log(`  HTML: ${html.length} chars, ${lineCount} lines`)
    log(`  DOCTYPE: ${hasDoctype}`)
    log(`  Has CSS: ${hasStyle}`)

    // Save it to verify visually
    try {
      const fs = require('fs')
      fs.writeFileSync('/tmp/cynco-test-mockup.html', html)
      log(`  Saved to /tmp/cynco-test-mockup.html`)
    } catch {}
  }
} else {
  results.push({ name: 'Mockup generates (no timeout)', pass: false, detail: 'Timeout after 5 min' })
  log('  TIMEOUT after 5 min')
}

// ═══════════════════════════════════════════════════════════════
// Test 4: SmallCode features — result capping + error diagnosis
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Test 4: SmallCode features (result capping, error diagnosis, blocking) ═══')

// Auto-approve
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)

// Test blocking command
const pre4 = (eventsByType.get('message.complete') ?? []).length

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Run this command: npm start',
}))

for (let i = 0; i < 60; i++) {
  if ((eventsByType.get('message.complete') ?? []).length > pre4) break
  await sleep(1000)
}

// Check if blocking worked — look for "Refused" in tool results
const toolCompletes = eventsByType.get('tool.complete') ?? []
const blockedTools = toolCompletes.filter(e =>
  typeof e.output === 'string' && e.output.includes('Refused')
)

results.push({
  name: 'Blocking command detection works',
  pass: blockedTools.length > 0 || toolCompletes.some(e => typeof e.output === 'string' && e.output.includes('Block')),
  detail: `Blocked tool results: ${blockedTools.length}`,
})

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Summary ═══')
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
