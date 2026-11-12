// "dndai is answered by CynCo's server meanwhile" was true for chat only (live hand-off, 2026-11-12 00:14Z).
//
// dndai's launcher runs its chat server in the foreground and an embeddings server on 8082 in the
// background, and stops the second when the first ends. After CynCo took 8081 nothing listened on 8082.
// CynCo does not stand in for that server (decision 9); the notice now says what else went down.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displaceApp } from '../../apps/displace.js'
import type { ListedProc, Proc } from '../../apps/portTree.js'
import type { LocalApp } from '../../apps/registry.js'

let home: string
let record: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-also-lost-')); record = join(home, 'displaced-apps.json') })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const ROOT = 'C:\\Users\\o\\dndai'
const BIN = 'C:\\Users\\o\\.cynco\\bin\\llama-server.exe'
const app: LocalApp = { id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', manage: true, source: 'by hand', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: ROOT } }
const listener: Proc = { pid: 4242, name: 'llama-server.exe', exe: BIN, commandLine: `"${BIN}" -m q.gguf --host 127.0.0.1 --port 8081`, created: 2 }
const row = (pid: number, ppid: number, commandLine: string, exe = 'C:\\x.exe'): ListedProc => ({ pid, ppid, exe, commandLine })
const launcher = row(4000, 1, 'bash scripts/start-llm.sh', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe')
const chat = row(4242, 4000, `"${BIN}" -m q.gguf --host 127.0.0.1 --port 8081`, BIN)
const embeddings = row(4243, 4000, `"${BIN}" -m nomic.gguf --host 127.0.0.1 --port 8082 --embedding -ngl 99`, BIN)
const webApp = row(5000, 1, `node "${ROOT}\\web\\node_modules\\next\\dist\\bin\\next" dev`)
const PLAIN = 'dndai\'s model server held port 8081 (pid 4242). CynCo stopped it to load its own model: dndai is answered by CynCo\'s server on the same port meanwhile, and its own server is started again when CynCo is done.'

const take = async (procs: ListedProc[], gone: number[]) => {
  const said: string[] = []
  const outcome = await displaceApp({ app, listener, launcherPid: 4000 }, {
    port: 8081, by: 'the chat engine (pid 77)', file: record, listProcesses: async () => procs,
    kill: async () => ({ stopped: true }), say: m => said.push(m),
    exists: pid => !gone.includes(pid), sleep: async () => {},
  })
  return { outcome, said }
}

describe('what else went down with an app\'s model server', () => {
  it('an embeddings server the launcher stopped with it is named, with its port, and CynCo says it does not stand in for it', async () => {
    const { outcome, said } = await take([launcher, chat, embeddings, webApp], [4243])
    expect(outcome).toBe('displaced')
    expect(said).toEqual([`${PLAIN} Its launcher also ended its embeddings server on port 8082 (pid 4243): CynCo does not stand in for that, so what dndai does with embeddings is down until its own server is back.`])
  })

  it('a process the launcher left running is not reported as lost', async () => {
    const { said } = await take([launcher, chat, embeddings, webApp], [])
    expect(said).toEqual([PLAIN])
  })

  it('a launcher that started only the one server gets the sentence it always got', async () => {
    const { said } = await take([launcher, chat, webApp], [4243])
    expect(said).toEqual([PLAIN])
  })

  it('another process of the launcher is named by what it is, and several are listed', async () => {
    const worker = row(4244, 4000, 'python tools\\reranker.py --port 8083', 'C:\\Python314\\python.exe')
    const { said } = await take([launcher, chat, embeddings, worker, webApp], [4243, 4244])
    expect(said[0]).toContain('Its launcher also ended its embeddings server on port 8082 (pid 4243) and python.exe on port 8083 (pid 4244): CynCo does not stand in for those')
  })

  it('the app itself, and what the stopped server had started, are not the launcher\'s other processes', async () => {
    const child = row(4300, 4242, 'conhost.exe 0x4')
    const { said } = await take([launcher, chat, child, webApp], [4300, 5000])
    expect(said).toEqual([PLAIN])
  })
})
