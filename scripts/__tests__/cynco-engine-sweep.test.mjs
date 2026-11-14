// Which engines a mission dispatch kills first (F234).
//
// The old sweep matched `-like '*engine/main.ts*'`, forward slash only. The
// phone engine (Task Scheduler, scripts/run-headless-engine.cmd) runs
// `bun engine\main.ts`, so it survived, the mission engine found 9160 taken,
// and the launch refused with "[ws] Port 9160 in use".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isSweptEngine, verdict, parseProcessRows, sweptEnginePids } from '../cynco-engine-sweep.mjs'

const BUN = 'C:\\Users\\civer\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe'
const phone = { pid: 19176, commandLine: `"${BUN}"    engine\\main.ts` }
const mission = { pid: 4242, commandLine: `${BUN} engine/main.ts` }
const absolute = { pid: 5151, commandLine: `"${BUN}" C:\\Users\\civer\\localcode\\engine\\main.ts` }
const oneShot = { pid: 6262, commandLine: `"${BUN}" C:\\Users\\civer\\localcode\\engine\\main.ts --run-task C:\\Users\\civer\\.cynco\\tasks\\t1.json` }
const daemon = { pid: 32908, commandLine: `"${BUN}"    engine\\daemon\\main.ts` }
const reporter = { pid: 36064, commandLine: `"${BUN}"    engine\\power\\reporter\\main.ts` }
const driver = { pid: 31396, commandLine: `${BUN} scripts/cynco-mission-driver.mjs C:/brief.txt "marker" C:\\Users\\civer\\casino` }
const lookalike = { pid: 7, commandLine: `${BUN} myengine/main.ts` }

describe('isSweptEngine', () => {
  it('the phone engine (backslash) is an engine: F234', () => {
    expect(isSweptEngine(phone)).toBe(true)
  })
  it('the mission engine (forward slash) and an engine by absolute path are engines', () => {
    expect(isSweptEngine(mission)).toBe(true)
    expect(isSweptEngine(absolute)).toBe(true)
  })
  it('a daemon one-shot is never swept: it holds its own GPU claim', () => {
    expect(isSweptEngine(oneShot)).toBe(false)
    expect(verdict(oneShot)).toMatch(/daemon one-shot/)
  })
  it('the daemon, the box reporter, the mission driver and a look-alike path are not engines', () => {
    for (const r of [daemon, reporter, driver, lookalike]) expect(isSweptEngine(r)).toBe(false)
  })
  it('a row whose command line could not be read is not killed on a guess', () => {
    expect(isSweptEngine({ pid: 1, commandLine: '' })).toBe(false)
    expect(verdict({ pid: 1, commandLine: '' })).toMatch(/could not be read/)
  })
})

describe('sweptEnginePids', () => {
  const out = [phone, mission, oneShot, daemon, reporter, driver].map(r => `${r.pid}|${r.commandLine}`).join('\r\n') + '\r\n'
  it('lists the engines from the process table and never its own pid', () => {
    expect(parseProcessRows(out).map(r => r.pid)).toEqual([19176, 4242, 6262, 32908, 36064, 31396])
    expect(sweptEnginePids({ platform: 'win32', run: () => out, self: 1 })).toEqual([19176, 4242])
    expect(sweptEnginePids({ platform: 'win32', run: () => out, self: 4242 })).toEqual([19176])
  })
  it('throws when the list cannot be read, so the dispatch refuses instead of going ahead blind', () => {
    expect(() => sweptEnginePids({ platform: 'win32', run: () => { throw new Error('access denied') } })).toThrow(/access denied/)
  })
})

describe('dispatch-mission.sh', () => {
  const sh = readFileSync('scripts/dispatch-mission.sh', 'utf-8')
  it('sweeps through the selector, refuses when it cannot list, and no longer matches the forward slash alone', () => {
    expect(sh).toMatch(/bun scripts\/cynco-engine-sweep\.mjs/)
    expect(sh).toMatch(/could not list the live engines — refusing to dispatch blind/)
    expect(sh).not.toMatch(/CommandLine -like '\*engine\/main\.ts\*'/)
  })
  it('stops the phone engine through its task before the sweep, and only when the task is running', () => {
    const stop = sh.indexOf('cynco-services.ps1 stop engine')
    const sweep = sh.indexOf('lc_engine_pids()')
    expect(stop).toBeGreaterThan(0)
    expect(stop).toBeLessThan(sweep)
    expect(sh).toMatch(/PHONE_ENGINE_TASK='CynCo headless engine'/)
    expect(sh).toMatch(/if \[ "\$\(phone_engine_task_state\)" = "Running" \]; then\s+PHONE_ENGINE_WAS_RUNNING=1/)
  })
  it('hands the phone engine back at mission end before falling back to the bare idle engine', () => {
    const start = sh.indexOf('cynco-services.ps1 start engine >>')
    const bare = sh.indexOf('bun engine/main.ts > "$IDLE_LOG"')
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(bare)
    expect(sh).toMatch(/if \[ -n "\$PHONE_ENGINE_WAS_RUNNING" \]; then\s+powershell -NoProfile -ExecutionPolicy Bypass -File scripts\/cynco-services\.ps1 start engine/)
  })
  it('requires the repository and hands the campaign id to the driver that writes the ledger row', () => {
    expect(sh).toMatch(/MISSION_CWD=\$\{3:\?missing cwd/)
    expect(sh).not.toMatch(/civkings\}/)
    // The env prefix of the driver's own launch line carries it.
    const before = sh.slice(0, sh.indexOf('  bun scripts/cynco-mission-driver.mjs'))
    expect(before.slice(before.lastIndexOf('CYNCO_CHECK_TIMEOUT_MS="$CYNCO_CHECK_TIMEOUT_MS"'))).toMatch(/CYNCO_CAMPAIGN_ID="\$\{CYNCO_CAMPAIGN_ID:-\}" \\/)
  })
})
