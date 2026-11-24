/**
 * Run under Bun by `engine/__tests__/audit/toolAuditConcurrency.test.ts` (F242): one of several
 * processes that append tool-call audit records to ONE shared day file at the same time, the way a
 * dispatch check, the mission driver and the engine do during a mission.
 *
 * argv: <dir> <count> <inputBytes> <startAtMs> [slowAfter]
 *   <dir>        a marked audit folder the test made under its own mkdtemp root; nothing else is written
 *   <count>      how many start records to write
 *   <inputBytes> the size of each record's input string
 *   <startAtMs>  wall-clock time to begin at, so that every writer starts together
 *   [slowAfter]  when given, the writer pauses 50 ms between records after record <slowAfter>, so a
 *                test can kill it while it is still writing
 *
 * After each `start` has returned it prints `started <i> <call>` on stdout; at the end it prints
 * `done <pid>`. Each record's input is `<pid>:<i>:` followed by one letter repeated, so the test can
 * tell that no line holds bytes of two records.
 */
import { createToolAudit } from '../../audit/toolAudit.js'

const [dir, countArg, bytesArg, startAtArg, slowAfterArg] = process.argv.slice(2)
if (!dir || !countArg || !bytesArg || !startAtArg) {
  console.error('usage: auditAppendMany.ts <dir> <count> <inputBytes> <startAtMs> [slowAfter]')
  process.exit(2)
}
const count = Number(countArg)
const bytes = Number(bytesArg)
const startAt = Number(startAtArg)
const slowAfter = slowAfterArg === undefined ? Number.POSITIVE_INFINITY : Number(slowAfterArg)

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

async function main(): Promise<void> {
  const wait = startAt - Date.now()
  if (wait > 0) await sleep(wait)
  const audit = createToolAudit({ dir: dir! })
  const letter = String.fromCharCode(97 + (process.pid % 26))
  for (let i = 1; i <= count; i++) {
    const head = `${process.pid}:${i}:`
    const input = head + letter.repeat(Math.max(0, bytes - head.length))
    const r = audit.start({ src: 'tool', tool: 'Bash', input: { command: input }, cwd: dir! })
    if (!r.ok) {
      console.error(`start ${i} refused: ${r.reason}`)
      process.exit(1)
    }
    process.stdout.write(`started ${i} ${r.call}\n`)
    if (i >= slowAfter) await sleep(50)
  }
  process.stdout.write(`done ${process.pid}\n`)
}

main().catch(e => {
  console.error(`fixture failed: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
