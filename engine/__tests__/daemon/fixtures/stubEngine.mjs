// engine/__tests__/daemon/fixtures/stubEngine.mjs
// Mimics `bun engine/main.ts --run-task <file>`: reads the task file,
// writes a canned outcome. Behavior switches on the task prompt.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const taskPath = process.argv[process.argv.indexOf('--run-task') + 1]
const task = JSON.parse(readFileSync(taskPath, 'utf-8'))

if (task.prompt.includes('HANG')) {
  // never exits — used to test the timeout kill
  setInterval(() => {}, 1000)
} else if (task.prompt.includes('CRASH')) {
  process.exit(1)
} else {
  mkdirSync(dirname(task.outcomePath), { recursive: true })
  writeFileSync(task.outcomePath, JSON.stringify({
    ok: true,
    summary: `stub ran for ${task.missionId}`,
    recommendations: [{ id: 'rec-stub', actionType: 'waiver', summary: 'Claim X', detail: 'stub' }],
  }), 'utf-8')
  process.exit(0)
}
