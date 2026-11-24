import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { DISPATCH_RUN_PREFIX } from '../../containment.js'

/**
 * BLOCKING wire-check for mission containment (F242).
 *
 * On 2026-11-22 one Bash call of an unattended mission deleted every dot-folder of the owner's
 * home. The containment layer (`engine/containment.ts`, the low-integrity launcher, harness git)
 * only helps where a child is actually started through it, and a process can be started from many
 * places: the tools, the loop, the daemon, the mission driver, the graders. A unit test proves a
 * site that goes through the layer behaves; only this listing proves that no site was forgotten,
 * and that a new one cannot be added without somebody deciding, in writing, what it runs and why.
 *
 * Each later slice of the containment work appends its pins below as a `describe` block of its own;
 * nothing already in this file is rewritten.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

// ---------------------------------------------------------------------------------------------
// Case 1: every process-creating call in engine/ and scripts/ is classified.
// ---------------------------------------------------------------------------------------------

const EXT = /\.(ts|mjs|js|cjs)$/
const SKIP_DIR = new Set(['__tests__', 'node_modules'])
const IMPORTS_CP = /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?child_process['"]/
const CP_NAMES = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']
const ALWAYS_NAMES = ['runSync', 'runAsync', 'toolExec', 'toolExecSync']
const CP_CALL = /(?<![\w$.])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/g
const NS_CALL = /(?<![\w$])(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/g
const ALWAYS = /(?<![\w$])(?:Bun\.spawn|Bun\.spawnSync|runSync|runAsync|toolExec|toolExecSync)\s*\(/g
/** A spawn function handed in: `io.run(`, `io.spawnSync(`, `this.exec(`, `deps.run(` ... */
const INJECTED = /(?<![\w$])(?:io|this|deps|hooks|opts)\.(?:run|runAsync|spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/g
/** Shapes that start a process and that no name above sees. Each one counts and makes the file a spawn site. */
const OTHER_SHAPES = [
  /(?<![\w$])Bun\.\$/g,
  /import\s*\{[^}]*\$[^}]*\}\s*from\s*['"]bun['"]/g,
  /import\(\s*`[^`]*child_process[^`]*`\s*\)/g,
]
/** The helpers a file can take by name from one of the modules that start processes. */
const HELPERS = new Set([...CP_NAMES, ...ALWAYS_NAMES, 'containedCommand'])
const SPAWN_MODULE = /^(?:node:)?child_process$|(?:^|\/)cynco-spawn\.mjs$|(?:^|\/)containment\.js$/

/**
 * Whole-line `//` comments dropped first, then block comments blanked; strings are left as they
 * are. A block comment opens only after a space, a line start or a bracket, so the `/*` inside
 * `engine/*.ts` (a line comment) or `'src/**' + '/*.ts'` (a glob) opens none.
 */
function strip(src: string): string {
  const lines = src.split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n')
  return lines.replace(/(^|[\s;{}(),=])\/\*[\s\S]*?\*\//g, (m, lead: string) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
}

const escapeRe = (s: string) => s.replace(/[$]/g, '\\$')
const callsOf = (src: string, name: string) => (src.match(new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, 'g')) ?? []).length

/**
 * What a file takes from a module that starts processes: the local names of the helpers it
 * imports (`{ exec as run }` gives `run`), the namespaces it imports (`import * as proc`, a
 * default import of child_process, `const cp = require(...)`), and the names a helper is handed on
 * to (`git = runSync`, `{ spawn = spawnSync }`, `const { spawn } = Bun`).
 */
function bindingsOf(src: string): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  const named = (list: string, sep: RegExp) => {
    for (const part of list.split(',')) {
      const [orig, local] = part.trim().split(sep).map(x => x.trim())
      if (orig && HELPERS.has(orig)) names.add(local || orig)
    }
  }
  for (const m of src.matchAll(/import\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!SPAWN_MODULE.test(m[2]!)) continue
    const clause = m[1]!
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause)
    if (ns) namespaces.add(ns[1]!)
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces) named(braces[1]!, /\s+as\s+/)
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim())
    if (def && /child_process/.test(m[2]!)) namespaces.add(def[1]!)
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!SPAWN_MODULE.test(m[2]!)) continue
    if (m[1]!.startsWith('{')) named(m[1]!.slice(1, -1), /\s*:\s*/)
    else namespaces.add(m[1]!)
  }
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*Bun\b/g)) {
    for (const part of m[1]!.split(',')) {
      const [orig, local] = part.trim().split(/\s*:\s*/)
      if (orig === 'spawn' || orig === 'spawnSync') names.add(local || orig)
    }
  }
  for (const m of src.matchAll(/(?<![=!<>\w$.])([\w$]+)\s*=\s*([\w$]+)\s*(?=[,;)}\n])/g)) {
    if (names.has(m[2]!) && m[1] !== m[2]) names.add(m[1]!)
  }
  return { names, namespaces }
}

/**
 * A file "creates a process" when it imports child_process in any shape (three files hand the
 * function on by reference and call it nowhere by name), takes a spawn helper by name from
 * child_process, `scripts/cynco-spawn.mjs` or `engine/containment.ts`, calls one of the names
 * above or a spawn function it was handed (`io.run(`), or uses one of the other shapes. The count
 * is lexical: it is a change detector, not a measure (a definition such as `export function
 * runSync(` counts too).
 */
function countOf(raw: string): { creates: boolean; count: number } {
  const src = strip(raw)
  const cp = IMPORTS_CP.test(raw)
  const { names, namespaces } = bindingsOf(src)
  const covered = new Set([...(cp ? CP_NAMES : []), ...ALWAYS_NAMES])
  let count = (cp ? (src.match(CP_CALL) ?? []).length + (src.match(NS_CALL) ?? []).length : 0)
    + (src.match(ALWAYS) ?? []).length + (src.match(INJECTED) ?? []).length
  for (const n of names) if (!covered.has(n)) count += callsOf(src, n)
  for (const ns of namespaces) {
    if (['child_process', 'childProcess', 'cp'].includes(ns) && cp) continue
    count += (src.match(new RegExp(`(?<![\\w$])${escapeRe(ns)}\\.(?:${[...HELPERS].join('|')})\\s*\\(`, 'g')) ?? []).length
  }
  let other = 0
  for (const re of OTHER_SHAPES) other += (src.match(re) ?? []).length
  count += other
  return { creates: cp || names.size > 0 || count > 0, count }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(p, out)
    } else if (EXT.test(name) && !/\.test\.[a-z]+$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
}

function scan(): Map<string, number> {
  const files: string[] = []
  walk(join(repoRoot, 'engine'), files)
  walk(join(repoRoot, 'scripts'), files)
  const found = new Map<string, number>()
  for (const f of files) {
    const { creates, count } = countOf(readFileSync(f, 'utf-8'))
    if (creates) found.set(relative(repoRoot, f).split(sep).join('/'), count)
  }
  return found
}

type SpawnClass = 'contained' | 'harness-git' | 'not-contained'

/**
 * The table, as the tree stands at the end of slice S2. `contained`: the child that runs workspace
 * code starts through toolExec, toolExecSync, containedCommand or the `contained` option.
 * `harness-git`: git the harness itself runs in a folder a contained run may have written, with
 * harnessGitEnv. `not-contained`: the reason says why the child never runs workspace code. A file
 * with calls of more than one class carries the class of its workspace-facing call; `git: true`
 * marks a `contained` file that also runs harness git. `via` names the file whose call a
 * `contained` row starts through, when the row only calls a function it was handed. Classified by
 * reading each call.
 */
const SPAWN_SITES: Record<string, { count: number; class: SpawnClass; git?: true; via?: string; reason: string }> = {
  // The containment itself.
  'engine/containment.ts': { count: 7, class: 'not-contained', reason: 'is the containment module: the definitions of toolExec / toolExecSync (which start the launcher), and icacls, whoami, PowerShell and the launcher probe run from the engine checkout by full path.' },
  'engine/lowIntegrityLauncher.ts': { count: 3, class: 'not-contained', reason: 'is the launcher: it lowers its own token to low integrity first, then starts the contained child.' },
  'engine/harnessGit.ts': { count: 1, class: 'harness-git', reason: 'its own filter listing (git config) in the folder, under the environment it is building.' },

  // The engine's sites that run workspace code (slice S2a).
  'engine/tools/impl/bash.ts': { count: 1, class: 'contained', reason: 'the Bash tool, through toolExec.' },
  'engine/tools/impl/git.ts': { count: 3, class: 'contained', reason: 'the Git tool and its after-commit status, through containedCommand into one Bun.spawn whose tree it owns (the run\'s own git: no harnessGitEnv).' },
  'engine/tools/impl/applyPatch.ts': { count: 1, class: 'contained', reason: 'git apply for the model, through toolExecSync.' },
  'engine/tools/contractVerify.ts': { count: 2, class: 'contained', git: true, reason: 'contract commands and verify-first through toolExec; the contract\'s git reads are harness git.' },
  'engine/bestOfN/sampler.ts': { count: 3, class: 'contained', git: true, reason: 'runTests through toolExecSync; the two git apply calls are harness git.' },
  'engine/lsp/manager.ts': { count: 2, class: 'contained', reason: 'tsc and py_compile diagnostics through one toolExecSync in runDiag (recorded by the tool-call audit, S5); the which / where lookup of a fixed server name runs in the engine\'s own folder.' },
  'engine/daemon/precheck.ts': { count: 1, class: 'contained', reason: 'a trigger\'s precheck command through toolExec in a precheck sandbox of its own.' },
  'engine/vsm/verifyFirst.ts': { count: 1, class: 'contained', via: 'engine/tools/contractVerify.ts', reason: 'calls the run it is handed (this.run), which the loop builds from runCommandDetailed: toolExec.' },

  // Harness git in a folder a contained run may have written.
  'engine/bestOfN/patchExtractor.ts': { count: 1, class: 'harness-git', reason: 'git add / diff in a candidate worktree, with HARNESS_DIFF_FLAGS on the diff.' },
  'engine/bestOfN/worktreeManager.ts': { count: 1, class: 'harness-git', reason: 'takes execSync by reference (this.exec); git worktree add / remove in the mission repository.' },
  'engine/bridge/conversationLoop.ts': { count: 4, class: 'harness-git', reason: 'git init, rev-parse, merge-base and status in the mission folder.' },
  'engine/tools/impl/write.ts': { count: 1, class: 'harness-git', reason: 'git ls-files for the shrink guard, named by -C.' },
  'engine/index/indexer.ts': { count: 4, class: 'harness-git', reason: 'ls-files, status, diff --name-only and rev-parse in the project folder, started by harnessGitBin().' },
  'engine/snapshot/snapshot.ts': { count: 4, class: 'harness-git', reason: 'the workspace snapshot\'s bare repository inside the work folder.' },
  'engine/dashboard/server.ts': { count: 1, class: 'harness-git', reason: 'the mission log (git -C <cwd> log) for the dashboard.' },
  'engine/training/gitFacts.ts': { count: 1, class: 'harness-git', reason: 'git facts of the mission folder for the trajectory, with HARNESS_DIFF_FLAGS on a diff.' },

  // Not contained: none of these runs code the run wrote.
  'engine/daemon/taskRunner.ts': { count: 4, class: 'not-contained', reason: 'starts the one-shot engine in the checkout, which adopts the daemon-task sandbox this runner made; tasklist, PowerShell and nvidia-smi probes.' },
  'engine/tools/impl/codeIndex.ts': { count: 1, class: 'not-contained', reason: 'rg, PowerShell or grep with no working folder, the folder and the query (after -e, or in the environment) as arguments; read-only.' },
  'engine/tools/impl/grep.ts': { count: 1, class: 'not-contained', reason: 'rg with no working folder, the model\'s pattern after -e and the folder after --, so no model text becomes an option such as --pre; read-only.' },
  'engine/tools/shellInfo.ts': { count: 4, class: 'not-contained', reason: 'parses a command (bash -n, the PowerShell parser) and runs none of it; where.exe pwsh.' },
  'engine/audit/auditLogger.ts': { count: 1, class: 'not-contained', reason: 'git rev-parse HEAD in the engine\'s own working folder, which a run cannot be given.' },
  'engine/projects/history.ts': { count: 1, class: 'not-contained', reason: 'git in a project folder; project chats are interactive and are not contained runs.' },
  'engine/llama/processManager.ts': { count: 8, class: 'not-contained', reason: 'starts, stops and frees the port of llama-server; never a workspace command.' },
  'engine/llama/binaryManager.ts': { count: 2, class: 'not-contained', reason: 'unpacks a llama.cpp release archive (PowerShell Expand-Archive or tar).' },
  'engine/llama/hostResources.ts': { count: 2, class: 'not-contained', reason: 'reads memory and GPU state (nvidia-smi, PowerShell).' },
  'engine/llama/portOwner.ts': { count: 1, class: 'not-contained', reason: 'names the process that holds the model port (PowerShell).' },
  'engine/brain/jlensSidecar.ts': { count: 3, class: 'not-contained', reason: 'starts and stops the lens sidecar from the engine\'s own tree.' },
  'engine/apps/desk.ts': { count: 4, class: 'not-contained', reason: 'starts the owner\'s other local-LLM apps from their registry recipe and makes their icons; never a workspace command.' },
  'engine/apps/displace.ts': { count: 2, class: 'not-contained', reason: 'restarts the app that held the model port, from its recorded launch line.' },
  'engine/apps/start.ts': { count: 2, class: 'not-contained', reason: 'starts an app of the owner\'s from its registry recipe (deps.run) and runs its readiness check; never a workspace command.' },
  'engine/apps/gitBash.ts': { count: 1, class: 'not-contained', reason: 'a where.exe lookup of git.exe on PATH.' },
  'engine/apps/gpu.ts': { count: 1, class: 'not-contained', reason: 'taskkill of a model server pid.' },
  'engine/apps/portTree.ts': { count: 1, class: 'not-contained', reason: 'a process listing through PowerShell.' },
  'engine/power/awake.ts': { count: 1, class: 'not-contained', reason: 'the hold-awake helper script from the checkout.' },
  'engine/power/siblingEngine.ts': { count: 2, class: 'not-contained', reason: 'stops and starts the phone engine through the services script in the checkout.' },
  'engine/power/reporter/gpu.ts': { count: 1, class: 'not-contained', reason: 'nvidia-smi for the box reporter.' },
  'engine/power/reporter/powerEvents.ts': { count: 1, class: 'not-contained', reason: 'reads the system power event log through PowerShell.' },
  'engine/processTree.ts': { count: 3, class: 'not-contained', reason: 'taskkill / pgrep on a pid: kills process trees.' },
  'engine/security/localToken.ts': { count: 1, class: 'not-contained', reason: 'icacls on the engine\'s own token file.' },
  'engine/skills/install.ts': { count: 0, class: 'not-contained', reason: 'promisify(execFile): unpacks a skill archive on the owner\'s request.' },
  'engine/training/runTraining.ts': { count: 2, class: 'not-contained', reason: 'a training command the owner starts by hand.' },

  // Scripts: the driver's check and probe, the graders and calibration (slice S2c).
  'scripts/cynco-spawn.mjs': { count: 7, class: 'contained', reason: 'runSync / runAsync with the contained option (two of the seven are their definitions, two are containedCommand); git.exe lookup and taskkill otherwise.' },
  'scripts/cynco-verify.mjs': { count: 2, class: 'contained', reason: 'runCheck / runCheckAsync forward contained for the driver\'s check and probe.' },
  'scripts/cynco-mission-driver.mjs': { count: 9, class: 'contained', git: true, reason: 'check and probe with contained: runContainment(); its git in the mission folder is harness git; PowerShell, taskkill and cynco-apps.mjs in the checkout at teardown.' },
  'scripts/cynco-campaign-grade.mjs': { count: 5, class: 'contained', git: true, reason: 'gate, suite gate and sweep with contained: { own }; the changed-files diff is harness git.' },
  'scripts/cynco-campaign-calibrate.mjs': { count: 6, class: 'contained', git: true, reason: 'gate, perturb, positive and baseline runs with contained: { own: baseDir }; archiveBase is harness git through Git Bash.' },
  'scripts/cynco-work-snapshot.mjs': { count: 2, class: 'harness-git', reason: 'git diff (with HARNESS_DIFF_FLAGS) and ls-files of the mission folder, started by harnessGitBin().' },
  'scripts/cynco-workspace.mjs': { count: 2, class: 'harness-git', reason: 'git ls-files in the mission folder through an injected spawnSync, started by harnessGitBin().' },
  'scripts/cynco-campaign.mjs': { count: 12, class: 'harness-git', reason: 'git reads of the mission repository; it starts the dispatch script, and its git and gh in the CynCo checkout or against the remote are not contained.' },
  'scripts/cynco-campaign-spec.mjs': { count: 1, class: 'harness-git', reason: 'git cat-file in the mission repository.' },
  'scripts/cynco-smoke-campaign.mjs': { count: 1, class: 'harness-git', reason: 'git rev-parse in the smoke repository.' },
  'scripts/cynco-gate-author.mjs': { count: 10, class: 'harness-git', reason: 'git in the staging folder; its bun --check child starts in the checkout, and the gate runs inside it are contained by calibrate.' },
  'scripts/cynco-ideation.mjs': { count: 1, class: 'not-contained', reason: 'starts the ideation one-shot engine in the checkout (rule H1) under a daemon-task sandbox it establishes and the engine adopts.' },
  'scripts/cynco-campaign-verdict.mjs': { count: 3, class: 'not-contained', reason: 'git in the CynCo checkout (the verdict commit) and node scripts/supervision-economics.mjs (io.run), from the checkout.' },
  'scripts/cynco-conduct-ab.mjs': { count: 1, class: 'not-contained', reason: 'git init, add and commit (git = runSync) in a folder it has just copied from the template, before any run is dispatched into it.' },
  'scripts/cynco-hindcast.mjs': { count: 4, class: 'not-contained', reason: 'the harness\'s own python retrain script (run = runSync), from the checkout, on datasets the harness wrote.' },
  'scripts/cynco-engine-sweep.mjs': { count: 1, class: 'not-contained', reason: 'a process listing through PowerShell.' },
  'scripts/cynco-llama-sweep.mjs': { count: 1, class: 'not-contained', reason: 'a process listing through PowerShell.' },
  'scripts/cynco-mission-end.mjs': { count: 1, class: 'not-contained', reason: 'reads a scheduled task\'s state through PowerShell.' },
  'scripts/codeindex-eval.mjs': { count: 2, class: 'not-contained', reason: 'a development evaluation, run by hand.' },
  'scripts/sync-cybernetics.ts': { count: 1, class: 'not-contained', reason: 'a development tool: git in the upstream repository.' },
  'scripts/vibe-e2e.ts': { count: 2, class: 'not-contained', reason: 'a development end-to-end run of the engine, by hand.' },
}

/**
 * What a `contained` row must show it uses. `{ contained }` is the shorthand by which
 * `scripts/cynco-verify.mjs` forwards the option.
 */
const CONTAINED_TOKENS = ['toolExec(', 'toolExecSync(', 'containedCommand(', 'contained:', '{ contained }', 'establishContainment(']

describe('containment wiring: every process-creating call is classified (F242)', () => {
  const found = scan()

  it('the counter sees every call shape and ignores whole-line comments', () => {
    const sample = [
      "import { exec } from 'node:child_process'",
      'exec("a")',
      '// execSync("in a comment")',
      '/* spawn("in a block") */',
      'cp.spawnSync("b")',
      'Bun.spawn(["c"])',
      'x.exec(/re/)',
      'runSync("d", [])',
    ].join('\n')
    expect(countOf(sample)).toEqual({ creates: true, count: 4 })
    expect(countOf("const { execSync } = require('child_process')\nthis.exec = opts.exec ?? execSync")).toEqual({ creates: true, count: 0 })
    expect(countOf('const re = /x/\nre.exec("y")')).toEqual({ creates: false, count: 0 })
  })

  // Review finding of slice S2: the shapes the first counter missed. Each adds to the count (and
  // makes the file a spawn site) without any of the names above appearing at a call.
  it('the counter sees aliases, namespaces, handed-in spawn functions and the other shapes', () => {
    const one = (src: string) => countOf(src)
    expect(one("import { exec as run } from 'node:child_process'\nrun('x')")).toEqual({ creates: true, count: 1 })
    expect(one("import * as proc from 'child_process'\nproc.spawnSync('x')")).toEqual({ creates: true, count: 1 })
    expect(one("import { runSync } from \"./cynco-spawn.mjs\"\nexport function seed(d, { git = runSync } = {}) {\n  git('git', ['init'])\n}")).toEqual({ creates: true, count: 1 })
    expect(one("import { runSync } from \"./cynco-spawn.mjs\"\nexport const f = (run = runSync) => 0")).toEqual({ creates: true, count: 0 })
    expect(one("const { spawn } = Bun\nspawn(['x'])")).toEqual({ creates: true, count: 1 })
    expect(one('io.run("python", [gate], { cwd })\nio.spawnSync("git", [])')).toEqual({ creates: true, count: 2 })
    expect(one('await Bun.$`rm -rf x`')).toEqual({ creates: true, count: 1 })
    expect(one("const m = await import(`node:${'child_process'}`)")).toEqual({ creates: true, count: 1 })
    expect(one("const m = await import(`child_process`)\nm.exec('x')")).toEqual({ creates: true, count: 1 })
    // A `/*` in a line comment or a glob opens no block comment.
    expect(one("// reaches engine/*.ts\nimport { runSync } from \"./cynco-spawn.mjs\"\nrunSync('x')\n// done */")).toEqual({ creates: true, count: 1 })
    // A namespace of the containment module that calls nothing of it creates nothing.
    expect(one("const c = await import('./containment.js')\nc.adoptContainment()")).toEqual({ creates: false, count: 0 })
  })

  // Each of these three names every offender at once, so one run shows the whole change to make.
  it('every file that starts a process is in SPAWN_SITES', () => {
    const missing = [...found].filter(([file]) => SPAWN_SITES[file] === undefined).map(([file, n]) => `${file} (${n})`)
    expect(missing, `these files start a process and are not classified. Add each to SPAWN_SITES in engine/__tests__/guards/containmentWiring.test.ts as contained (it runs through toolExec, toolExecSync, containedCommand or the contained option), harness-git (git with harnessGitEnv in a folder a contained run may have written) or not-contained, with the reason in one sentence`).toEqual([])
  })

  it('every row still exists and still starts a process', () => {
    const stale = Object.keys(SPAWN_SITES).filter(file => !found.has(file))
    expect(stale, 'these rows no longer start a process (or no longer exist): remove them').toEqual([])
  })

  it('every count is the scan\'s count', () => {
    const wrong = Object.entries(SPAWN_SITES)
      .filter(([file, row]) => found.has(file) && found.get(file) !== row.count)
      .map(([file, row]) => `${file}: scan ${found.get(file)}, table ${row.count}`)
    expect(wrong, 'process-creating calls changed. Read each new call, decide its class, then correct the count').toEqual([])
  })

  it('every class is honest about the source', () => {
    for (const [file, row] of Object.entries(SPAWN_SITES)) {
      const src = read(file)
      if (row.class === 'contained') {
        const through = row.via === undefined ? src : read(row.via)
        expect(CONTAINED_TOKENS.some(t => through.includes(t)), `${row.via ?? file} (for ${file}) is classed contained but uses none of ${CONTAINED_TOKENS.join(', ')}`).toBe(true)
      }
      if (row.via !== undefined) expect(row.class, `${file}: via belongs on a contained row`).toBe('contained')
      if (row.class === 'harness-git' || row.git) {
        expect(src.includes('harnessGitEnv('), `${file} is classed as running harness git but never calls harnessGitEnv(`).toBe(true)
      }
      if (row.git) expect(row.class, `${file}: git: true belongs on a contained row`).toBe('contained')
      if (row.class === 'not-contained') {
        expect(row.reason.length, `${file} is not contained, so its reason must say why in a sentence`).toBeGreaterThanOrEqual(20)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Cases 2 to 6: where the boot block, the Bash tool, the dispatch, the driver and the ideation
// one-shot take the containment.
// ---------------------------------------------------------------------------------------------

describe('containment wiring: the pins of slices S1 and S2 (F242)', () => {
  it('the boot block adopts the sandbox after the job object and before the model loads', () => {
    const src = read('engine/main.ts')
    const task = src.indexOf('readTaskFile(p)')
    const job = src.indexOf('installKillOnCloseJob()')
    const adopt = src.indexOf('adoptContainment(')
    const model = src.indexOf('await bootstrapProvider(')
    expect(task).toBeGreaterThan(-1)
    expect(task).toBeLessThan(job)
    expect(job).toBeLessThan(adopt)
    expect(adopt).toBeLessThan(model)
  })

  it('the Bash tool starts its shell through toolExec, after the refusal, and owns the launcher\'s tree', () => {
    const src = read('engine/tools/impl/bash.ts')
    expect(src).toContain('toolExec(runnable')
    expect(src).not.toMatch(/(?<![A-Za-z])exec\(runnable/)
    expect(src).not.toMatch(/from ['"](?:node:)?child_process['"]/)
    const refusal = src.indexOf('toolSpawnRefusal()')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(src.indexOf('toolExec(runnable'))
    // F201, F210: the pid the engine owns is the launcher's.
    expect(src).toContain('ownProcessTree(child.pid)')
  })

  it('the dispatch makes the sandbox after its exit trap and before the engine starts, and releases it', () => {
    const src = read('scripts/dispatch-mission.sh')
    const mint = src.indexOf('cynco-sandbox.mjs mint')
    const trap = src.indexOf('trap dispatch_abandoned EXIT')
    const create = src.indexOf('cynco-sandbox.mjs create --run-id "$RUN_ID"')
    const engine = src.indexOf('bun engine/main.ts >')
    expect(mint).toBeGreaterThan(-1)
    expect(mint).toBeLessThan(trap)
    expect(trap).toBeLessThan(create)
    expect(create).toBeLessThan(engine)
    expect(src.split('LOCALCODE_MISSION_RUN_ID="$RUN_ID"').length - 1).toBe(2)
    // The engine keeps its real home; only its tools get the sandbox.
    expect(src).not.toMatch(/^\s*(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)=/m)
    // The script tests the switch and never sets it.
    expect(src).not.toContain('LOCALCODE_CONTAINMENT_OFF=')
    expect(src).toContain('cynco-sandbox.mjs release-dead --kind mission')
    const release = src.indexOf('cynco-sandbox.mjs release "$RUN_ID" >>')
    expect(release).toBeGreaterThan(src.indexOf('cynco-mission-end.mjs'))
  })

  it('the driver adopts the sandbox before it connects, and both dispatch chains require the word', () => {
    const src = read('scripts/cynco-mission-driver.mjs')
    const adopt = src.indexOf('adoptContainment(')
    expect(adopt).toBeGreaterThan(-1)
    expect(adopt).toBeLessThan(src.indexOf('let ws = new WebSocket('))
    expect(src.split('?? containmentDispatchRefusal({').length - 1).toBe(2)
  })

  it('rule H1: the ideation one-shot starts in the checkout, never in the mission repository', () => {
    const src = read('scripts/cynco-ideation.mjs')
    // The sandbox is established through a test seam: `(io?.contain ?? establishContainment)(...)`.
    expect(src).toContain("(io?.contain ?? establishContainment)({ kind: 'daemon-task'")
    // runTask's last argument is the child's working folder.
    expect(src).toContain('(io?.runTask ?? runTask)(repoRoot, taskPath, env, repoRoot)')
    expect(src).not.toMatch(/runTask\)\([^)]*spec\.repo\)/)
  })
})

// ---------------------------------------------------------------------------------------------
// Slice S2, per call: a file-level token proves nothing about one call in a file of many (review
// finding of slice S2), so the calls that run workspace code or git in a run's folder are pinned
// one by one, with 01-isolation section 9.7's text pins.
// ---------------------------------------------------------------------------------------------

/**
 * The text of every call whose callee matches `callee` (a pattern ending at the callee's name),
 * from the name to its matching `)`. Strings, template literals and line comments inside the call
 * are skipped while the brackets are counted.
 */
function callsTo(src: string, callee: RegExp): string[] {
  const out: string[] = []
  const re = new RegExp(`${callee.source}\\s*\\(`, 'g')
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length
    let depth = 1
    let quote: string | null = null
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    out.push(src.slice(m.index!, i))
  }
  return out
}

describe('containment wiring: slice S2, call by call (F242)', () => {
  it('the call scanner reads a whole call, brackets and strings included', () => {
    const src = "io.run('python', [f('a)')], { cwd, contained: { own } })\nio.run('x')"
    expect(callsTo(src, /(?<![\w$])io\.run/)).toEqual(["io.run('python', [f('a)')], { cwd, contained: { own } })", "io.run('x')"])
  })

  it('every grader and calibration run carries the contained option or the harness-git environment', () => {
    for (const file of ['scripts/cynco-campaign-grade.mjs', 'scripts/cynco-campaign-calibrate.mjs']) {
      const calls = callsTo(strip(read(file)), /(?<![\w$])io\.run/)
      expect(calls.length, file).toBe(SPAWN_SITES[file]!.count - (file.endsWith('grade.mjs') ? 2 : 1))
      for (const call of calls) {
        expect(/contained:\s*\{/.test(call) || call.includes('harnessGitEnv('), `${file}: ${call.slice(0, 160)}`).toBe(true)
      }
    }
  })

  it('every git the driver starts in the mission folder carries harnessGitEnv', () => {
    const src = strip(read('scripts/cynco-mission-driver.mjs'))
    const calls = [...callsTo(src, /(?<![\w$.])spawnSync/), ...callsTo(src, /(?<![\w$])Bun\.spawn/)]
      .filter(c => /^(?:spawnSync\(\s*GIT\b|Bun\.spawn\(\s*\[\s*GIT\b)/.test(c))
    expect(calls.length).toBe(6)
    for (const call of calls) expect(call, call.slice(0, 160)).toContain('harnessGitEnv(')
  })

  it('the driver\'s probe and marker check run under its adopted containment (9.7)', () => {
    const src = read('scripts/cynco-mission-driver.mjs')
    // S5 adds the audit option to the same options objects; the containment stays first.
    expect(src).toContain('runCheck(probeCmd, CWD, PROBE_TIMEOUT_MS, { contained: runContainment(), audit: ')
    expect(src).toContain('runCheckAsync(MARKER.command, CWD, MARKER.timeoutMs, { env: { CYNCO_CHECK_ORDINAL: String(ordinal) }, contained: runContainment(), audit: ')
  })

  it('a contract command starts through toolExec and never through a bare exec (9.7)', () => {
    const src = strip(read('engine/tools/contractVerify.ts'))
    expect(src).toContain('toolExec(')
    expect(src).not.toMatch(/(?<![\w.$])exec\(/)
  })

  it('the dispatch makes the sandbox before it stops the phone engine, and releases it when it stops early (9.7)', () => {
    const src = read('scripts/dispatch-mission.sh')
    const create = src.indexOf('cynco-sandbox.mjs create')
    expect(create).toBeGreaterThan(-1)
    expect(create).toBeLessThan(src.indexOf('cynco-services.ps1 stop engine'))
    const fn = src.indexOf('dispatch_abandoned() {')
    expect(fn).toBeGreaterThan(-1)
    const body = src.slice(fn, src.indexOf('\n}\n', fn))
    expect(body).toContain('cynco-sandbox.mjs release "$RUN_ID"')
  })

  it('only the daemon precheck hands toolExec an environment of its own (9.7)', () => {
    const files: string[] = []
    walk(join(repoRoot, 'engine'), files)
    walk(join(repoRoot, 'scripts'), files)
    const withEnv: string[] = []
    for (const f of files) {
      const rel = relative(repoRoot, f).split(sep).join('/')
      if (rel === 'engine/containment.ts') continue
      for (const call of callsTo(strip(readFileSync(f, 'utf-8')), /(?<![\w$.])toolExec/)) {
        if (/\benv\s*:/.test(call)) withEnv.push(rel)
      }
    }
    expect(withEnv).toEqual(['engine/daemon/precheck.ts'])
  })
})

// ---------------------------------------------------------------------------------------------
// Slice S3: the rule in every brief (entry 6.M8). Tested against the SOURCE TEXT, where a
// backslash is spelled twice: `C:\\tmp` in source is `C:\tmp` in the sentence the model reads.
// ---------------------------------------------------------------------------------------------

const TMP = /C:(\\+|\/)tmp/i
const IMPORTS_MISSION_RULE = /from ['"][^'"]*missionRule(\.js)?['"]/

/** The harness's own uses of C:/tmp in a file that also holds model-facing text: a decision, not an oversight. */
const HARNESS_TMP_USES = [
  { file: 'scripts/cynco-gate-author.mjs', text: 'return `C:/tmp/${id}_author_base`',
    reason: 'BASE archive and uncommitted-work patches written by the harness, never by a tool call: the BASE archive is made by the harness, read by the author, handed to the run as an extra root (1.B2)' },
  { file: 'scripts/cynco-gate-author.mjs', text: "export const WORK_SNAPSHOT_DIR = 'C:/tmp'",
    reason: 'BASE archive and uncommitted-work patches written by the harness, never by a tool call: where the driver, a harness process, leaves a stopped mission\'s uncommitted tree; a run reads it and never writes it' },
]

describe('containment wiring: the model is sent to its scratch folder, never to C:\\tmp (S3, entry 6.M8)', () => {
  it('the revert refusal and the brief generator name no C:\\tmp and do name the scratch folder', () => {
    for (const rel of ['engine/vsm/missionInvariants.ts', 'scripts/cynco-brief.mjs']) {
      const src = read(rel)
      expect(src, rel).not.toMatch(TMP)
      expect(src.includes('scratch folder') || IMPORTS_MISSION_RULE.test(src), rel).toBe(true)
    }
    const inv = read('engine/vsm/missionInvariants.ts')
    expect(inv).toMatch(IMPORTS_MISSION_RULE)
    expect(inv).toContain("'out and why. Keep a copy you want in ' + SCRATCH_PHRASE + ', never in a stash.'")
    const brief = read('scripts/cynco-brief.mjs')
    expect(brief).toContain('- Probes live in ${SCRATCH_PHRASE}, never in the repo.')
    expect(brief).toContain('MISSION_FIXED_RULE_LINES.map(')
  })

  it('the download refusal names the brief\'s full path, never a home spelling', () => {
    const src = read('engine/tools/approvalGate.ts')
    expect(src).not.toContain('~/.cynco/staging')
    expect(src).not.toContain('.cynco/staging')
    expect(src).toContain('the brief names the folder by its full path; copy what you need from there into the mission folder')
  })

  it('the harness\'s own uses of C:/tmp are listed, and each is still where it was', () => {
    for (const use of HARNESS_TMP_USES) {
      expect(use.reason.length, use.text).toBeGreaterThan(0)
      expect(read(use.file), `${use.file}: ${use.text}`).toContain(use.text)
    }
  })

  it('the driver builds the first message once, before its socket, and sends it', () => {
    const src = read('scripts/cynco-mission-driver.mjs').replace(/\r\n/g, '\n')
    const built = src.indexOf('withFixedRule(task, runContainment().sandbox.scratch)')
    const fn = src.indexOf('function dispatchMission()')
    expect(built).toBeGreaterThan(-1)
    expect(fn).toBeGreaterThan(-1)
    expect(built).toBeLessThan(fn)
    const body = src.slice(fn, src.indexOf('\n}\n', fn))
    expect(body).toContain('text: firstMessage')
    expect(body).not.toMatch(/text: task\b/)
  })

  it('the one-shot sends a contained run its scratch path, and the authoring brief carries the rule', () => {
    expect(read('engine/daemon/oneShot.ts')).toContain('withFixedRule(first, contained.sandbox.scratch)')
    const author = read('scripts/cynco-gate-author.mjs')
    expect(author).toMatch(IMPORTS_MISSION_RULE)
    expect(author).toContain('Fixed rule — ${MISSION_FIXED_RULE_LINES[0]}')
    expect(author).toContain('Fixed rule — ${MISSION_FIXED_RULE_LINES[1]}')
  })

  it('the fixed rule names no sealed instrument', async () => {
    const rule = await import('../../missionRule.js')
    for (const text of [rule.MISSION_FIXED_RULE, rule.MISSION_FIXED_RULE_SHORT, rule.SCRATCH_PHRASE, ...rule.MISSION_FIXED_RULE_LINES]) {
      expect(text).not.toMatch(/heldout/i)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// S4 (work package 2): the protected-path check sits where the design says. These pins live here
// and nowhere else.
// ---------------------------------------------------------------------------------------------

describe('the protected-path check (S4, F242 layer 2)', () => {
  it('the executor asks the path check where the design says', () => {
    const ex = read('engine/tools/executor.ts').replace(/\r\n/g, '\n')
    // Since S5 the checks live in preRun, which execute asks before the tool runs.
    const pre = ex.slice(ex.indexOf('private async preRun('))
    const secret = pre.indexOf('secretPathOf(toolName')
    const guard = pre.indexOf('checkProtectedPaths(toolName, input, this.cwd)')
    expect(secret).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(secret)
    const exec = ex.slice(ex.indexOf('  async execute(toolName'), ex.indexOf('private async preRun('))
    expect(exec.indexOf('await this.preRun(toolName, input)')).toBeGreaterThan(-1)
    expect(exec.indexOf('await tool.execute(')).toBeGreaterThan(exec.indexOf('await this.preRun(toolName, input)'))
    expect(ex).toContain('redactSealed(guard.text)')

    const bash = read('engine/tools/impl/bash.ts').replace(/\r\n/g, '\n')
    const safety = bash.indexOf('checkBashSafety(command)')
    const bashGuard = bash.indexOf("checkProtectedPaths('Bash', input, cwd)")
    const spawn = bash.indexOf('toolExec(runnable')
    expect(safety).toBeGreaterThan(-1)
    expect(bashGuard).toBeGreaterThan(safety)
    expect(spawn).toBeGreaterThan(bashGuard)
  })
})

// ---------------------------------------------------------------------------------------------
// S5 (work package 3): the tool-call audit sits where the design says (03-audit-logs 8.1).
// ---------------------------------------------------------------------------------------------

describe('the tool-call audit (S5, F242)', () => {
  const src = (rel: string) => read(rel).replace(/\r\n/g, '\n')
  /** From a declaration to the end of its body: the first line that closes at the declaration's indent. */
  const body = (text: string, decl: string) => {
    const at = text.indexOf(decl)
    expect(at, decl).toBeGreaterThan(-1)
    const lineStart = text.lastIndexOf('\n', at) + 1
    const indent = /^[ \t]*/.exec(text.slice(lineStart))![0]
    const end = text.indexOf(`\n${indent}}\n`, at)
    return text.slice(at, end === -1 ? undefined : end)
  }

  it('the executor: one tool.execute, the start before it and before its try, the code at both rebuild sites', () => {
    const ex = src('engine/tools/executor.ts')
    expect(ex.split('tool.execute(').length - 1).toBe(1)
    const run = ex.indexOf('tool.execute(')
    const start = ex.indexOf('audit.start(')
    const tryAt = ex.lastIndexOf('try {', run)
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(tryAt)
    expect(ex.indexOf('exitCode: result.exitCode', ex.indexOf('const capped = {'))).toBeGreaterThan(ex.indexOf('const capped = {'))
    expect(ex.indexOf('exitCode: capped.exitCode', ex.indexOf('DOOM LOOP DETECTED'))).toBeGreaterThan(ex.indexOf('DOOM LOOP DETECTED'))
    expect(ex).toContain("audit?.refused({")
    expect(ex).toContain('export function refusalFaultOf(')
  })

  it('the loop: one auditDenied call per denial site plus the AskUser redirect, and the fault sink', () => {
    const loop = src('engine/bridge/conversationLoop.ts')
    const calls = loop.split('auditDenied(').length - 1
    const denials = (loop.match(/^[ \t]+this\.recordToolOutcome\(toolName, 'denied', toolResultsThisTurn\)$/gm) ?? []).length
    expect(denials).toBeGreaterThan(0)
    expect(calls).toBe(denials + 1)
    expect(loop).toContain('setContainmentFaultSink(')
    expect(loop).toMatch(/const recordDenial = \(\) => this\.governance\.onToolResult\(/)
  })

  it('each site that runs workspace code without the executor asks the audit before it starts the command', () => {
    const sites: Array<[string, string, string]> = [
      ['engine/tools/contractVerify.ts', 'export function runCommandDetailed(', 'toolExec('],
      ['engine/bestOfN/sampler.ts', 'export function runTests(', 'toolExecSync('],
      ['engine/lsp/manager.ts', 'private runDiag(', 'toolExecSync('],
      ['engine/daemon/precheck.ts', 'export function runPrecheck(', 'toolExec('],
    ]
    for (const [file, decl, spawn] of sites) {
      const b = body(src(file), decl)
      const audit = b.indexOf('toolAudit(')
      expect(audit, `${file}: toolAudit( in ${decl}`).toBeGreaterThan(-1)
      expect(b.indexOf(spawn), `${file}: ${spawn} after toolAudit(`).toBeGreaterThan(audit)
    }
  })

  it('the daemon hands refuseRun to both runners; the boot asks the audit before the model loads', () => {
    expect(src('engine/daemon/main.ts').split('refuse: refuseRun').length - 1).toBe(2)
    const main = src('engine/main.ts')
    expect(main.indexOf("probe('preflight')")).toBeGreaterThan(-1)
    expect(main.indexOf('await bootstrapProvider(')).toBeGreaterThan(main.indexOf("probe('preflight')"))
  })

  it('the scripts: runCheck forwards audit, the driver probes before its first change on disk, the graders record', () => {
    const verify = src('scripts/cynco-verify.mjs')
    expect(body(verify, 'export function runCheck(')).toContain('...(audit ? { audit } : {})')
    expect(body(verify, 'export async function runCheckAsync(')).toContain('...(audit ? { audit } : {})')
    const driver = src('scripts/cynco-mission-driver.mjs')
    expect(driver.indexOf("probe('driver')")).toBeGreaterThan(-1)
    expect(driver.indexOf('purgeBytecodeCaches(CWD)')).toBeGreaterThan(driver.indexOf("probe('driver')"))
    expect(driver).toContain("audit: { handle: audit, src: 'driver-probe' }")
    expect(driver).toContain("audit: { handle: audit, src: 'driver-marker' }")
    for (const f of ['scripts/cynco-campaign-grade.mjs', 'scripts/cynco-campaign-calibrate.mjs']) {
      expect(src(f), f).toContain("audit: { handle: harnessAudit(), src: 'gate' }")
    }
  })

  it('the dispatch: the audit gate before anything is stopped, the verify inside the watcher before its case', () => {
    const sh = src('scripts/dispatch-mission.sh')
    const check = sh.indexOf('bun scripts/cynco-audit.mjs check')
    expect(check).toBeGreaterThan(-1)
    expect(sh.indexOf('PHONE_ENGINE_TASK=')).toBeGreaterThan(check)
    expect(sh.indexOf('trap dispatch_abandoned EXIT')).toBeGreaterThan(check)
    const watch = sh.indexOf('while kill -0 "$DRIVER_PID"')
    const verify = sh.indexOf('bun scripts/cynco-audit.mjs verify --run "$RUN_ID"')
    const esac = sh.indexOf('esac', watch)
    expect(verify).toBeGreaterThan(watch)
    expect(esac).toBeGreaterThan(verify)
  })

  // Review of slice S5: the one call the loop makes on a tool object outside the executor (the
  // CodeIndex-first card, whose regex fallback starts rg or PowerShell with the model's pattern) has its
  // start written before it runs and its end after; a start that cannot be written runs nothing.
  it('the CodeIndex-first card records its own CodeIndex call', () => {
    const loop = src('engine/bridge/conversationLoop.ts')
    const call = loop.indexOf('ci = await codeIndexTool.execute(ciInput, ciCwd)')
    const start = loop.indexOf("ciAudit.start({ src: 'tool', tool: 'CodeIndex', input: ciInput, cwd: ciCwd })")
    expect(start).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(start)
    expect(loop.slice(start, call)).toContain('if (ciStarted && !ciStarted.ok) return')
    expect(loop.indexOf('ciAudit.end(ciStarted.call', call)).toBeGreaterThan(call)
    // No other `.execute(` on a tool object in the loop.
    expect(loop.match(/codeIndexTool\.execute\(/g)?.length).toBe(1)
  })
})

// ─── Slice S7: the integrity manifest, the latch and the tripwire (04 section 5.2) ──────────────
describe('the integrity layer (S7, F242)', () => {
  const src = (rel: string) => read(rel).replace(/\r\n/g, '\n')
  const after = (text: string, a: string, b: string) => {
    const i = text.indexOf(a), j = text.indexOf(b)
    expect(i, a).toBeGreaterThan(-1)
    expect(j, b).toBeGreaterThan(-1)
    return j > i
  }
  /** Every non-test source file under engine/ and scripts/, as [repo-relative path, text]. */
  const sources = (): Array<[string, string]> => {
    const files: string[] = []
    walk(join(repoRoot, 'engine'), files)
    walk(join(repoRoot, 'scripts'), files)
    return files.map(f => [relative(repoRoot, f).split(sep).join('/'), readFileSync(f, 'utf-8')])
  }

  it('(1) dispatch-mission.sh: the guard before the trap, the baseline after it, the two settles where the engine is dead', () => {
    const sh = src('scripts/dispatch-mission.sh')
    const trap = sh.indexOf('trap dispatch_abandoned EXIT')
    expect(sh.indexOf('cynco-guard.mjs status --quiet')).toBeLessThan(trap)
    const pre = sh.indexOf('cynco-guard.mjs pre')
    expect(pre).toBeGreaterThan(trap)
    expect(pre).toBeLessThan(sh.indexOf('cynco-services.ps1 stop engine'))
    expect(pre).toBeLessThan(sh.indexOf('cynco-sandbox.mjs create'))
    const fn = sh.slice(sh.indexOf('dispatch_abandoned() {'), trap)
    expect(fn.indexOf('--by dispatch-abandoned')).toBeGreaterThan(fn.indexOf('taskkill //PID "$ENGINE_WINPID"'))
    const watcher = sh.indexOf('--by dispatch-watcher')
    expect(watcher).toBeGreaterThan(sh.indexOf('bun scripts/cynco-mission-end.mjs'))
    expect(watcher).toBeLessThan(sh.indexOf('cynco-audit.mjs verify'))
    expect(watcher).toBeLessThan(sh.indexOf('cynco-sandbox.mjs release "$RUN_ID" >>'))
    expect(watcher).toBeLessThan(sh.indexOf("sed -n 's/^ACTION //p'"))
    // Ruling 3.3: the line the script prints and the line the runner reads share one constant.
    expect(sh).toContain('echo "' + DISPATCH_RUN_PREFIX + '$RUN_ID"')
    expect(src('scripts/cynco-campaign.mjs')).toContain('line.startsWith(DISPATCH_RUN_PREFIX)')
  })

  it('(2) the driver asks the latch before it adopts, and its poll ends the mission as integrity-latch', () => {
    const driver = src('scripts/cynco-mission-driver.mjs')
    expect(after(driver, 'haltRefusal(', 'adoptContainment(')).toBe(true)
    expect(driver).toContain("exitReason = 'integrity-latch'")
  })

  it('(3) the campaign: decide asks integrity first; main refuses under the latch before the in-flight block', () => {
    const c = src('scripts/cynco-campaign.mjs')
    const decide = c.slice(c.indexOf('export function decide('))
    const firstStatement = decide.split('\n')[1]!
    expect(firstStatement).toContain('row?.integrity?.changed')
    const main = c.slice(c.indexOf('export async function main('))
    expect(after(main, 'defaultIo.integrity.refusal()', 'if (state.state.inFlight)')).toBe(true)
  })

  it('(4) the daemon: isPaused is the control file or a standing latch; TaskRunner is given the control file alone', () => {
    const d = src('engine/daemon/main.ts')
    const line = d.split('\n').find(l => /^const isPaused = /.test(l))
    expect(line).toBeDefined()
    // Review of wave 5: an unusable guard folder is not a pause (it refuses each run, which pages); only a latch pauses.
    expect(line).toContain('latchStands()')
    expect(d).toContain("const latchStands = (): string | null => { const s = haltState(); return s.state === 'latched' ? s.summary : null }")
    expect(d).toContain('halted: latchWhy')
    expect(d).toContain('shouldPause: controlPaused')
  })

  it('(5) the task runner: the integrity calls are not hooks', () => {
    const tr = src('engine/daemon/taskRunner.ts')
    const hooks = tr.match(/\bhook\([^\n]*/g) ?? []
    expect(hooks.length).toBeGreaterThan(0)
    for (const h of hooks) expect(h, h).not.toContain('integrity')
  })

  it('(6) cynco-services.ps1: the exit code is read on the line that collects, with no pipe; only the daemon is refused', () => {
    const ps = src('scripts/cynco-services.ps1')
    const line = ps.split('\n').find(l => l.includes('& bun') && l.includes('cynco-guard.mjs'))
    expect(line).toBeDefined()
    expect(line!.indexOf('$guardExit = $LASTEXITCODE')).toBeGreaterThan(line!.indexOf('& bun'))
    expect(line).not.toContain('|')
    const refusal = ps.split('\n').find(l => l.includes('start REFUSED: integrity'))
    expect(refusal).toContain("$s.Name -eq 'daemon'")
  })

  it('(7) the boot: the latch and the tripwire before the model loads', () => {
    const main = src('engine/main.ts')
    const load = main.indexOf('await bootstrapProvider(')
    expect(main.indexOf('haltRefusal(')).toBeGreaterThan(-1)
    expect(main.indexOf('haltRefusal(')).toBeLessThan(load)
    expect(main.indexOf('startPresenceTripwire(')).toBeGreaterThan(-1)
    expect(main.indexOf('startPresenceTripwire(')).toBeLessThan(load)
  })

  it('(8) the executor: the tripwire is the first check of preRun, before the sealed check', () => {
    const ex = src('engine/tools/executor.ts')
    const pre = ex.slice(ex.indexOf('private async preRun('))
    expect(pre.indexOf('presenceTripwireCheck()')).toBeGreaterThan(-1)
    expect(pre.indexOf('presenceTripwireCheck()')).toBeLessThan(pre.indexOf('callTouchesSealed('))
  })

  it('(9) LOCALCODE_GUARD_DIR is read in exactly one file under engine/ and in none under scripts/', () => {
    const READ = /\b(?:process\.)?env\.LOCALCODE_GUARD_DIR\b/
    const readers = sources().filter(([, text]) => READ.test(text)).map(([rel]) => rel)
    expect(readers).toEqual(['engine/paths.ts'])
  })

  it('(10) no file but engine/integrity.ts writes, renames, removes or opens the latch', () => {
    const OP = /writeFileSync|renameSync|unlinkSync|rmSync|openSync/
    const offenders: string[] = []
    for (const [rel, text] of sources()) {
      if (rel === 'engine/integrity.ts') continue
      for (const l of text.split('\n')) if ((l.includes('HALT.json') || l.includes('LATCH_FILE')) && OP.test(l)) offenders.push(`${rel}: ${l.trim()}`)
    }
    expect(offenders).toEqual([])
  })
})

// ─── Slice S8: the logs (03 section 8.1) ────────────────────────────────────────────────────────
describe('the logs (S8, F242)', () => {
  const src = (rel: string) => read(rel).replace(/\r\n/g, '\n')
  /** The target of a `>>` redirect on a line, quotes kept, or null. */
  const appendTarget = (line: string): string | null => {
    const m = />>\s*("[^"]+"|[^\s"]+)/.exec(line)
    return m ? m[1]! : null
  }

  it('every scripts/run-*.cmd that appends to a log rotates that same log first', () => {
    const launchers = readdirSync(join(repoRoot, 'scripts')).filter(n => /^run-.*\.cmd$/i.test(n)).sort()
    const appending: string[] = []
    for (const name of launchers) {
      const lines = src(`scripts/${name}`).split('\n')
      const targets = new Map<string, number>()
      lines.forEach((l, i) => {
        if (/^\s*rem\b/i.test(l)) return
        const t = appendTarget(l)
        if (t !== null && !targets.has(t)) targets.set(t, i)
      })
      if (targets.size === 0) continue
      appending.push(name)
      for (const [target, first] of targets) {
        const call = lines.findIndex(l => l.trim() === `call "%~dp0rotate-log.cmd" ${target}`)
        expect(call, `${name}: no rotate-log.cmd call for ${target}`).toBeGreaterThan(-1)
        expect(call, `${name}: the rotation of ${target} comes after a line that appends to it`).toBeLessThan(first)
      }
    }
    expect(appending).toEqual(['run-box-reporter.cmd', 'run-daemon.cmd', 'run-embed-server.cmd', 'run-headless-engine.cmd'])
  })

  it('the default cap in scripts/rotate-log.cmd is a number below 2147483647', () => {
    const m = /^if "%MAX%"=="" set "MAX=(\d+)"$/m.exec(src('scripts/rotate-log.cmd'))
    expect(m).not.toBeNull()
    const cap = Number(m![1])
    expect(cap).toBeGreaterThan(0)
    expect(cap).toBeLessThan(2147483647)
  })

  it('the daemon row of scripts/cynco-services.ps1 registers scripts\\run-daemon.cmd', () => {
    const row = src('scripts/cynco-services.ps1').split('\n').find(l => l.includes("Name = 'daemon';"))
    expect(row).toBeDefined()
    expect(row).toMatch(/Register = @\{ Action = \(Join-Path \$repo 'scripts\\run-daemon\.cmd'\)/)
    expect(row).toContain("Match = 'engine\\\\daemon\\\\main'")
  })

  it('dispatch-mission.sh prunes old mission logs only after every gate and before the phone engine is stopped', () => {
    const sh = src('scripts/dispatch-mission.sh')
    const PRUNE = 'bun scripts/cynco-logs.mjs prune-mission-logs'
    const prune = sh.indexOf(PRUNE)
    expect(prune).toBeGreaterThan(-1)
    expect(sh.indexOf('prune-mission-logs', prune + PRUNE.length)).toBe(-1)
    expect(prune).toBeGreaterThan(sh.indexOf('trap dispatch_abandoned EXIT'))
    expect(prune).toBeGreaterThan(sh.indexOf('cynco-guard.mjs pre'))
    expect(prune).toBeGreaterThan(sh.indexOf('cynco-sandbox.mjs create'))
    expect(prune).toBeLessThan(sh.indexOf('cynco-services.ps1 stop engine'))
    // It keeps this dispatch's own two logs, and a failure never ends the dispatch.
    const line = sh.slice(prune, sh.indexOf('\n', prune))
    expect(line).toContain('--keep "$ENGINE_LOG" --keep "$DRIVER_LOG"')
    expect(line).toContain('|| echo "[dispatch] old mission logs not pruned (see above)"')
    expect(line).not.toContain('--dir')
  })

  it('the stream debug log is written only through appendCapped, inside its try', () => {
    const loop = src('engine/bridge/conversationLoop.ts')
    const at = loop.indexOf("'.cynco-stream.log'")
    expect(at).toBeGreaterThan(-1)
    expect(loop.indexOf("'.cynco-stream.log'", at + 1)).toBe(-1)
    const before = loop.slice(loop.lastIndexOf('try {', at), at)
    expect(before).toContain('appendCapped(')
    expect(before).not.toContain('appendFileSync')
    expect(loop.slice(at, loop.indexOf('} catch', at))).toContain('STREAM_LOG_MAX_BYTES')
  })

  it('the daemon starts the hourly housekeeping and stops it on shutdown', () => {
    const d = src('engine/daemon/main.ts')
    expect(d).toContain("import { runHousekeeping } from './housekeeping.js'")
    expect(d).toContain('const housekeeping = setInterval(housekeep, 3_600_000)')
    expect(d).toContain('logsDir: cyncoHome()')
    expect(d).toContain('queueOnFailure: false')
    const shutdown = d.slice(d.indexOf('const shutdown = () => {'))
    expect(shutdown.indexOf('clearInterval(housekeeping)')).toBeGreaterThan(shutdown.indexOf('clearInterval(interval)'))
  })
})
