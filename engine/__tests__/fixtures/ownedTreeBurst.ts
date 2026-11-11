/**
 * Run under Bun by `engine/__tests__/processTreeJob.test.ts` (F210).
 *
 * A shell starts CHILDREN small children one after another as fast as it can;
 * each writes `started-<n>` at once and `marker-<n>` about three seconds
 * later. As soon as a few have started, and so while the shell is still
 * starting more, the tree is killed through `ownProcessTree`. Then the
 * survivors are counted: a marker is a child that outlived the kill. Prints
 * one JSON line.
 *
 * The children are `cmd` + `ping`, not `node`: a hundred node processes
 * starting at once is the load F207 was about, and this runs inside the suite.
 *
 * argv: <scratch dir> <mode: own | walk>. `walk` kills with `killProcessTree`
 * instead, to show by hand what the Job Object is for. The engine's own job is
 * installed first, as `main.ts` does, so the command's job nests inside it.
 */
import { exec } from 'child_process'
import { readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { killProcessTree, ownProcessTree } from '../../processTree.js'
import { installKillOnCloseJob } from '../../security/jobObject.js'

const [dir, mode] = process.argv.slice(2)
const CHILDREN = 60
const KILL_AFTER_STARTED = 8
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const engineJob = await installKillOnCloseJob()
// `ping -n 4` is a three-second wait that needs no console input.
writeFileSync(join(dir, 'late.cmd'), '@echo off\r\necho x> started-%1\r\nping -n 4 127.0.0.1 >nul\r\necho x> marker-%1\r\n')
const child = exec(
  `1..${CHILDREN} | ForEach-Object { Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c', '.\\late.cmd', $_ }`, // `.\\`: cmd does not always search the current directory
  { cwd: dir, shell: 'powershell.exe' },
  () => {},
)
const tree = mode === 'own' ? ownProcessTree(child.pid) : null
const count = (prefix: string) => readdirSync(dir).filter(f => f.startsWith(prefix)).length

const giveUp = Date.now() + 30_000
while (count('started-') < KILL_AFTER_STARTED && Date.now() < giveUp) await sleep(15)
const startedAtKill = count('started-')
const t0 = Date.now()
if (tree) await tree.kill()
else await killProcessTree(child.pid!)
const killMs = Date.now() - t0
await sleep(6000)
console.log(JSON.stringify({ mode, kind: tree?.kind ?? 'walk', engineJob: engineJob.installed, children: CHILDREN, startedAtKill, started: count('started-'), survivors: count('marker-'), killMs }))
process.exit(0)
