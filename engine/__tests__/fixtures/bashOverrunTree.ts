/**
 * Run under Bun by `engine/__tests__/tools/bashOverrunTree.test.ts` (wave 19).
 *
 * The real, uncontained Bash tool runs a PowerShell command that starts a child (a node that waits two minutes and
 * needs no console) and writes its pid to a file, then prints 3 MiB, more than the tool's 2 MiB `maxBuffer`. exec
 * then ends the shell alone (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, with `killed` unset: measured by the
 * harness-children builder, wave 15b); the tool must end the tree it owns. A second later the child is asked for.
 * Prints one JSON line. The engine's own kill-on-close job is installed first, as `main.ts` does, so nothing this
 * fixture started outlives it.
 *
 * The child is asked about and ended by a mark in its command line (`helpers/markedProcesses.ts`), never by its
 * number (F255, wave 24: a number read from a file names whatever process has it now). A control runs first: the same
 * command without the overrun leaves the same marked child running, and the mark finds it, so "gone" after the
 * overrun cannot be the answer of a mark that finds nothing. Whatever carries a mark at the end is ended by it.
 *
 * argv: <scratch dir>
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { bashTool } from '../../tools/impl/bash.js'
import { installKillOnCloseJob } from '../../security/jobObject.js'
import { endMarked, isMarked, newMark } from '../helpers/markedProcesses.js'

const [dir] = process.argv.slice(2)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const engineJob = await installKillOnCloseJob()

/** Runs the Bash tool on a command that starts a marked child, and asks a second later whether it runs. */
async function child(name: string, mark: string, overrun: boolean) {
  const pidFile = join(dir, `${name}.pid`)
  const command = `$p = Start-Process -FilePath node -ArgumentList '-e','setTimeout(()=>{},120000)/*${mark}*/' -WindowStyle Hidden -PassThru; ` +
    `Set-Content -LiteralPath '${pidFile}' -Value $p.Id -Encoding ascii; Start-Sleep -Milliseconds 300` + (overrun ? `; 'y' * 3145728` : '')
  const r = await bashTool.execute({ command, timeout: 60_000 }, dir)
  const pid = Number(readFileSync(pidFile, 'utf-8').trim())
  await sleep(1000)
  const aliveAfter = Number.isInteger(pid) && pid > 0 && isMarked(pid, mark)
  return { pid, aliveAfter, r }
}

const controlMark = newMark('bashOverrunControl')
const caseMark = newMark('bashOverrun')
let control: { pid: number; aliveAfter: boolean; isError: boolean } | null = null
let result: Awaited<ReturnType<typeof child>> | null = null
try {
  const c = await child('control', controlMark, false)
  control = { pid: c.pid, aliveAfter: c.aliveAfter, isError: c.r.isError }
  result = await child('overrun', caseMark, true)
} finally {
  endMarked(controlMark)
  endMarked(caseMark)
}
const { pid, aliveAfter, r } = result!
console.log(JSON.stringify({ engineJob, control, pid, aliveAfter, isError: r.isError, exitCode: (r as { exitCode?: unknown }).exitCode ?? null, head: String(r.output).slice(0, 160) }))
