/**
 * Run under Bun by `engine/__tests__/tools/bashOverrunTree.test.ts` (wave 19).
 *
 * The real, uncontained Bash tool runs a PowerShell command that starts a child (`ping -n 120`, a two-minute wait
 * that needs no console) and writes its pid to a file, then prints 3 MiB, more than the tool's 2 MiB `maxBuffer`.
 * exec then ends the shell alone (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, with `killed` unset: measured by the
 * harness-children builder, wave 15b); the tool must end the tree it owns. A second later the child's pid is asked
 * for. Prints one JSON line. The engine's own kill-on-close job is installed first, as `main.ts` does, so nothing
 * this fixture started outlives it; a child still alive at the end is ended here (it is this fixture's own).
 *
 * argv: <scratch dir>
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { bashTool } from '../../tools/impl/bash.js'
import { installKillOnCloseJob } from '../../security/jobObject.js'

const [dir] = process.argv.slice(2)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const engineJob = await installKillOnCloseJob()
const pidFile = join(dir, 'pid.txt')
const command = `$p = Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; ` +
  `Set-Content -LiteralPath '${pidFile}' -Value $p.Id -Encoding ascii; Start-Sleep -Milliseconds 300; 'y' * 3145728`
const r = await bashTool.execute({ command, timeout: 60_000 }, dir)
const pid = Number(readFileSync(pidFile, 'utf-8').trim())
await sleep(1000)
const aliveAfter = Number.isInteger(pid) && pid > 0 && alive(pid)
if (aliveAfter) process.kill(pid)
console.log(JSON.stringify({ engineJob, pid, aliveAfter, isError: r.isError, exitCode: (r as { exitCode?: unknown }).exitCode ?? null, head: String(r.output).slice(0, 160) }))
