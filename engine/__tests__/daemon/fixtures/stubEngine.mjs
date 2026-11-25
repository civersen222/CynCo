// engine/__tests__/daemon/fixtures/stubEngine.mjs
// Mimics `bun engine/main.ts --run-task <file>`: reads the task file,
// writes a canned outcome. Behavior switches on the task prompt.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const taskPath = process.argv[process.argv.indexOf('--run-task') + 1]
const task = JSON.parse(readFileSync(taskPath, 'utf-8'))

// The stand-ins that run "until killed" end by themselves after two minutes, far past any case that uses them
// (F255): what a failing case leaves running does not have to be ended by anyone.
const LONG_MS = 120_000
if (task.prompt.includes('HANG')) {
  // does not exit within any case's time — used to test the timeout kill
  setTimeout(() => {}, LONG_MS)
} else if (task.prompt.includes('PAUSEME')) {
  // announces its journal like the real engine, then runs until killed — the pause test
  console.log('[session] Journal: C:/Users/x/.cynco/sessions/session-424242.jsonl')
  setTimeout(() => {}, LONG_MS)
} else if (task.prompt.includes('WRITE_LATE')) {
  // Wave 24 (A4): runs, and writes `outlived.txt` beside its outcome 2.5 s later unless it is ended first.
  setTimeout(() => {
    mkdirSync(dirname(task.outcomePath), { recursive: true })
    writeFileSync(`${dirname(task.outcomePath)}/outlived.txt`, 'x', 'utf-8')
  }, 2500)
} else if (task.prompt.includes('CRASH')) {
  process.exit(1)
} else if (task.prompt.includes('ECHO_ENV')) {
  mkdirSync(dirname(task.outcomePath), { recursive: true })
  writeFileSync(task.outcomePath, JSON.stringify({
    ok: true,
    summary: `env keys: ${Object.keys(process.env).filter((k) => k.startsWith('CYNCO_')).join(',') || '(none)'}`,
    recommendations: [],
  }), 'utf-8')
  process.exit(0)
} else {
  mkdirSync(dirname(task.outcomePath), { recursive: true })
  writeFileSync(task.outcomePath, JSON.stringify({
    ok: true,
    summary: `stub ran for ${task.missionId}`,
    recommendations: [{ id: 'rec-stub', actionType: 'waiver', summary: 'Claim X', detail: 'stub' }],
  }), 'utf-8')
  process.exit(0)
}
