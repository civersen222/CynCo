import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, dirname, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'
import { DISPATCH_RUN_PREFIX } from '../../containment.js'

/**
 * BLOCKING wire-check for mission containment (F242).
 *
 * On 2026-11-22 one Bash call of an unattended mission deleted every dot-folder of the owner's
 * home and then the application folders of AppData\Local up to "pip". The containment layer (`engine/containment.ts`, the low-integrity launcher, harness git)
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
 * `Bun.$` counted as code only: a file whose text holds the lexical shape is parsed, and only a
 * property access `Bun.$` in the syntax tree counts, so the shape inside a string, a template's
 * text or a comment (the path check names that call in its own messages) is not a spawn site.
 */
function bunShellCalls(raw: string, src: string): number {
  if (!OTHER_SHAPES[0]!.test(src)) return 0
  OTHER_SHAPES[0]!.lastIndex = 0
  let n = 0
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'Bun' && node.name.text === '$') n++
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('x.ts', raw, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS))
  return n
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
  for (const re of OTHER_SHAPES) other += re === OTHER_SHAPES[0] ? bunShellCalls(raw, src) : (src.match(re) ?? []).length
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
  // Wave 19 (A5, from the box core builder, P2-B10): the reason changed on purpose; runOnce starts the system
  // programs in System32 (harnessChildCwd), which this user cannot write.
  // Wave 19b (A-F5, the box core builder's pin): 7 to 8 on purpose; holdGitNamespace starts one idle sh.exe of the
  // installed Git at normal integrity in System32 (harnessChildCwd) for as long as contained children may start.
  'engine/containment.ts': { count: 8, class: 'not-contained', reason: 'is the containment module: the definitions of toolExec / toolExecSync (which start the launcher), icacls, whoami and PowerShell run by full path in System32 (harnessChildCwd), the launcher probe run from the engine checkout, and the holder of the installed Git\'s namespace (one idle sh.exe of Git at normal integrity in System32, B1).' },
  // Wave 19 (A5): 3 to 4 on purpose; since wave 15 the shell form starts a PowerShell by argv (shellStart, two spawnSync).
  'engine/lowIntegrityLauncher.ts': { count: 4, class: 'not-contained', reason: 'is the launcher: it lowers its own token to low integrity first, then starts the contained child (a PowerShell by argv with -NoProfile -NonInteractive, any other shell through shell:).' },
  // Wave 19 (A5, from the integrity builder): knownFolderPlaces reads the user's shell folders.
  'engine/integrity.ts': { count: 1, class: 'not-contained', reason: 'reg.exe query of the user\'s shell folders, by its full path and read-only, for the known folders of a baseline whose home the system reports as this account\'s own profile (wave 15, 15b); never a workspace command.' },
  'engine/harnessGit.ts': { count: 1, class: 'harness-git', reason: 'its own filter listing (git config) in the folder, under the environment it is building.' },

  // The engine's sites that run workspace code (slice S2a).
  'engine/tools/impl/bash.ts': { count: 1, class: 'contained', reason: 'the Bash tool, through toolExec.' },
  'engine/tools/impl/git.ts': { count: 3, class: 'contained', reason: 'the Git tool and its after-commit status, through containedCommand into one Bun.spawn whose tree it owns (the run\'s own git: no harnessGitEnv).' },
  'engine/tools/impl/applyPatch.ts': { count: 1, class: 'contained', reason: 'git apply for the model, through toolExecSync.' },
  'engine/tools/contractVerify.ts': { count: 2, class: 'contained', git: true, reason: 'contract commands and verify-first through toolExec, owned by ownedExec (engine/processTree.ts); the contract\'s git reads are harness git.' },
  // Wave 19 (A5, from the harness-children builder): the reasons changed on purpose (runTests and runDiag own
  // their trees); lsp/manager.ts 2 to 4: tsc through toolExec, py_compile through containedCommand into execFile.
  // Wave 19c (package D, check D19b-6): the two git apply calls are one execFileSync helper now, so the count is 2 (was 3).
  'engine/bestOfN/sampler.ts': { count: 2, class: 'contained', git: true, reason: 'runTests through toolExec, which owns the tree and ends it at its cap, and on an output overrun when a Job Object holds it; the two git apply calls are harness git through one execFileSync of harnessGitBin with an argument vector, no shell, under GIT_TIMEOUT_MS (wave 19c), after every path the patch writes is walked for a link.' },
  'engine/lsp/manager.ts': { count: 4, class: 'contained', reason: 'tsc diagnostics through toolExec and py_compile through containedCommand into one execFile (the file one argument, never shell text), both in runDiag, which owns the tree and ends it at its cap, and on an output overrun when a Job Object holds it (recorded by the tool-call audit, S5); the which / where lookup of a fixed server name runs in the engine\'s own folder.' },
  'engine/daemon/precheck.ts': { count: 1, class: 'contained', reason: 'a trigger\'s precheck command through toolExec in a precheck sandbox of its own, owned by ownedExec.' },
  'engine/print3d/run.ts': { count: 2, class: 'contained', reason: 'runProgram starts OpenSCAD on a design the model wrote, and Bambu Studio on the mesh it made, through containedCommand into one execFile with an argument vector (no shell), owned by ownedExec (its cap, the turn\'s Stop); it runs inside a MakeModel tool call, which the executor audits.' },
  'engine/vsm/verifyFirst.ts': { count: 1, class: 'contained', via: 'engine/tools/contractVerify.ts', reason: 'calls the run it is handed (this.run), which the loop builds from runCommandDetailed: toolExec.' },

  // Harness git in a folder a contained run may have written.
  // Wave 19 (A5): 1 to 2 on purpose (the check-ignore execFileSync of the link walk).
  'engine/bestOfN/patchExtractor.ts': { count: 2, class: 'harness-git', reason: 'after a walk of the worktree by its listings that never enters a link, git ls-files (the index) and check-ignore (names only, walking nothing) through execFileSync, and rev-parse --verify HEAD in a nested folder that lists a .git (an embedded repository is not walked), then git add / diff / reset in a candidate worktree, with HARNESS_DIFF_FLAGS on the diff, the same way (execFileSync of harnessGitBin under GIT_TIMEOUT_MS, wave 19c; was execSync with no cap).' },
  'engine/bestOfN/worktreeManager.ts': { count: 1, class: 'harness-git', reason: 'takes execFileSync by reference (this.exec) and starts harnessGitBin with an argument vector, no shell (wave 19b, check D19-1); git worktree add / list / prune / unlock / remove in the mission repository.' },
  'engine/bridge/conversationLoop.ts': { count: 4, class: 'harness-git', reason: 'git init, rev-parse, merge-base and status in the mission folder.' },
  'engine/tools/impl/write.ts': { count: 1, class: 'harness-git', reason: 'git ls-files for the shrink guard, named by -C.' },
  'engine/index/indexer.ts': { count: 4, class: 'harness-git', reason: 'ls-files, status, diff --name-only and rev-parse in the project folder, started by harnessGitBin().' },
  'engine/snapshot/snapshot.ts': { count: 4, class: 'harness-git', reason: 'the workspace snapshot\'s bare repository inside the work folder.' },
  'engine/dashboard/server.ts': { count: 1, class: 'harness-git', reason: 'the mission log (git -C <cwd> log) for the dashboard.' },
  'engine/training/gitFacts.ts': { count: 1, class: 'harness-git', reason: 'git facts of the mission folder for the trajectory, with HARNESS_DIFF_FLAGS on a diff.' },

  // Not contained: none of these runs code the run wrote.
  // Wave 19 (A5): 4 to 5 on purpose (baselineInChild).
  'engine/daemon/taskRunner.ts': { count: 5, class: 'not-contained', reason: 'starts the one-shot engine in the checkout, which adopts the daemon-task sandbox this runner made; the run\'s integrity baseline in bun scripts/cynco-guard.mjs pre from the checkout (wave 15); tasklist, PowerShell and nvidia-smi probes.' },
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
  // Changed on purpose in wave 19: 10 to 9. The staging folder's tree-writing git goes through one helper with
  // worktreeLinks (A3); runAuthorCheck's execFile (decision sheet item 25) and its test seam hooks.execFile are two more.
  'scripts/cynco-gate-author.mjs': { count: 9, class: 'harness-git', reason: 'git in the staging folder (the tree-writing calls with worktreeLinks); its bun --check child starts in the checkout, by the runner and, under the authoring dispatch\'s mark, by the mission driver (runAuthorCheck: argv, --no-install, its tree owned), and the gate runs inside it are contained by calibrate.' },
  'scripts/cynco-ideation.mjs': { count: 1, class: 'not-contained', reason: 'starts the ideation one-shot engine in the checkout (rule H1) under a daemon-task sandbox it establishes and the engine adopts.' },
  // Changed on purpose in wave 22: 16 to 17; readAclOf reads a folder's access list through PowerShell (read only).
  'scripts/cynco-containment-acceptance.mjs': { count: 17, class: 'not-contained', reason: 'the acceptance harness: it starts its own inner process with a fake-home environment, and establishes a test containment there; it reads the planted git settings back with the harness git before its control runs, and unsets them with the harness git when it disarms the test repository at the end; in the real-profile stage it asks the registry (reg query, read only) before its probe as well as after; since wave 22 it reads a folder\'s access list through Windows PowerShell (readAclOf, read only) before an establish and after the recovery of a grant a release kept.' },
  'scripts/cynco-campaign-verdict.mjs': { count: 3, class: 'not-contained', reason: 'git in the CynCo checkout (the verdict commit) and node scripts/supervision-economics.mjs (io.run), from the checkout.' },
  'scripts/cynco-conduct-ab.mjs': { count: 1, class: 'not-contained', reason: 'git init, add and commit (git = runSync) in a folder it has just copied from the template, before any run is dispatched into it.' },
  'scripts/cynco-hindcast.mjs': { count: 4, class: 'not-contained', reason: 'the harness\'s own python retrain script (run = runSync), from the checkout, on datasets the harness wrote.' },
  'scripts/cynco-engine-sweep.mjs': { count: 1, class: 'not-contained', reason: 'a process listing through PowerShell.' },
  'scripts/cynco-llama-sweep.mjs': { count: 1, class: 'not-contained', reason: 'a process listing through PowerShell.' },
  // Changed on purpose in wave 13c (C4, C7): the second call is tasklist, asked for the image of the engine's pid
  // before that pid is waited for or killed.
  // Changed on purpose in wave 13d (R8): a third call reads the engine pid's creation time through PowerShell.
  'scripts/cynco-mission-end.mjs': { count: 3, class: 'not-contained', reason: 'reads a scheduled task\'s state through PowerShell, the engine pid\'s image through tasklist, and its creation time through PowerShell.' },
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
    expect(one('const $ = Bun.$\nawait $`rm -rf x`')).toEqual({ creates: true, count: 1 })
    // The shape named inside a string, a template's text or a comment is not a call.
    expect(one("const why = 'Bun.$ with a command built at run time'\nconst at = `${via}>Bun.$`\n// Bun's shell (`Bun.$`)")).toEqual({ creates: false, count: 0 })
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
    // F201, F210: the tree the engine owns is the launcher's. Changed on purpose in wave 24 (F255), was
    // `ownProcessTree(child.pid)`: the launcher's process is handed over, so a walked tree is never killed by its
    // number once its exit was handled.
    expect(src).toContain('ownProcessTree(child)')
    expect(src).not.toContain('ownProcessTree(child.pid)')
  })

  it('the dispatch makes the sandbox after its exit trap and before the engine starts, and releases it', () => {
    const src = read('scripts/dispatch-mission.sh')
    const mint = src.indexOf('cynco-sandbox.mjs mint')
    const trap = src.indexOf('trap dispatch_abandoned EXIT')
    const create = src.indexOf('cynco-sandbox.mjs create --run-id "$RUN_ID"')
    const engine = src.indexOf('bun --no-install engine/main.ts >')
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
    for (const call of calls) {
      // Changed on purpose in wave 19b (check A-R6): the F132 reset runs with `resetEnv`, the harnessGitEnv it judged
      // with isHarnessRefused (the A3 case pins both), so the tree is walked once and a reset is never claimed when a
      // second walk refused.
      if (call.startsWith("spawnSync(GIT, ['checkout', '--', '.'], { cwd: CWD, env: resetEnv })")) {
        expect(src).toContain('const resetEnv = harnessGitEnv(process.env, { repo: CWD, worktreeLinks: true })')
        continue
      }
      expect(call, call.slice(0, 160)).toContain('harnessGitEnv(')
    }
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
    // Wave 15c (N7): the Bash tool judges the command it translated too, on CI as well (the behaviour case in
    // tools/protectedPaths.test.ts runs on Windows only).
    const translated = bash.indexOf('autoTranslateEnvPrefix(command, shellInfo)')
    const again = bash.indexOf("checkProtectedPaths('Bash', { command: dialected }, cwd)")
    expect(translated).toBeGreaterThan(bashGuard)
    expect(again).toBeGreaterThan(translated)
    expect(spawn).toBeGreaterThan(again)
    expect(bash.slice(again)).toMatch(/^checkProtectedPaths\('Bash', \{ command: dialected \}, cwd\)\n\s*if \(again\.kind === 'refuse'\) return \{ output: again\.text, isError: true \}/)
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
    // Wave 19 (A5, the harness-children builder's pins with its check's C4-7): each site is async now (it awaits
    // the confirmed tripwire first), and its first toolAudit( is the tripwire's refused record, so the needle is the
    // site's audit START, which must come before every spawn of the body.
    const sites: Array<[string, string, string, string[]]> = [
      ['engine/tools/contractVerify.ts', 'export async function runCommandDetailed(', "audit.start({ src: 'contract'", ['toolExec(']],
      ['engine/bestOfN/sampler.ts', 'export async function runTests(', "audit.start({ src: 'best-of-n'", ['toolExec(']],
      ['engine/lsp/manager.ts', 'private async runDiag(', "audit.start({ src: 'lsp'", ['toolExec(', 'containedCommand(']],
      ['engine/daemon/precheck.ts', 'export async function runPrecheck(', "audit.start({ src: 'precheck'", ['toolExec(']],
    ]
    for (const [file, decl, start, spawns] of sites) {
      const b = body(src(file), decl)
      const audit = b.indexOf(start)
      expect(audit, `${file}: ${start} in ${decl}`).toBeGreaterThan(-1)
      for (const spawn of spawns) {
        expect(b.indexOf(spawn), `${file}: ${spawn} in ${decl}`).toBeGreaterThan(-1)
        expect(b.indexOf(spawn), `${file}: ${spawn} after ${start}`).toBeGreaterThan(audit)
      }
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
    // Wave 19 (A5, the graders builder's pin 1, R3-F1): both graders make their audit handle for the run id of their own
    // containment, so the records carry `run`.
    for (const f of ['scripts/cynco-campaign-grade.mjs', 'scripts/cynco-campaign-calibrate.mjs']) {
      expect(src(f), f).toContain("audit: { forRun: (run) => harnessAudit({ run }), src: 'gate' }")
    }
  })

  it('the dispatch: the audit gate before anything is stopped, the verify inside the watcher before its case', () => {
    const sh = src('scripts/dispatch-mission.sh')
    const check = sh.indexOf('bun --no-install scripts/cynco-audit.mjs check')
    expect(check).toBeGreaterThan(-1)
    expect(sh.indexOf('PHONE_ENGINE_TASK=')).toBeGreaterThan(check)
    expect(sh.indexOf('trap dispatch_abandoned EXIT')).toBeGreaterThan(check)
    const watch = sh.indexOf('while kill -0 "$DRIVER_PID"')
    const verify = sh.indexOf('bun --no-install scripts/cynco-audit.mjs verify --run "$RUN_ID"')
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
    expect(watcher).toBeGreaterThan(sh.indexOf('bun --no-install scripts/cynco-mission-end.mjs'))
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
    // Changed on purpose in wave 19 (plan P6 item 6): the poll's exit reason comes from integrityStop, which names the
    // latch `integrity-latch` and a guard folder that cannot be used `integrity-guard-unusable`.
    expect(driver).toContain("return { exitReason: 'integrity-latch', why: state.summary, line: latchLine(state.summary, teardownEngine) }")
    expect(driver).toContain('    exitReason = stopNow.exitReason\n')
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
    // Wave 19 (A5, from the integrity builder): preRun awaits the confirmed tripwire (wave 15, item 1).
    expect(pre.indexOf('await presenceTripwireConfirmed()')).toBeGreaterThan(-1)
    expect(pre.indexOf('await presenceTripwireConfirmed()')).toBeLessThan(pre.indexOf('callTouchesSealed('))
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
        if (l.trim().startsWith('call "%~dp0rotate-log.cmd" ')) return  // wave 15: the call line's own 2>> goes to <svc>.rotate.log, not a service log
        const t = appendTarget(l)
        if (t !== null && !targets.has(t)) targets.set(t, i)
      })
      if (targets.size === 0) continue
      appending.push(name)
      for (const [target, first] of targets) {
        // Wave 19 (A5, from the integrity builder, wave 15 item 11): the call carries its own 2>> to <svc>.rotate.log.
        const call = lines.findIndex(l => l.trim() === `call "%~dp0rotate-log.cmd" ${target} 2>> ${target.replace(/\.log"$/, '.rotate.log"')}`)
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
    const PRUNE = 'bun --no-install scripts/cynco-logs.mjs prune-mission-logs'
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

// ---------------------------------------------------------------------------------------------
// Slice S9 (A20): the acceptance script holds destructive text through its catalog. An inner
// process may hold it only after `innerSelfCheck` has shown that it sees a fake home; these pins
// keep the order and the spelling that make that true. Read as text; nothing here is imported or run.
// ---------------------------------------------------------------------------------------------

describe('the acceptance script cannot hold attack text before it has checked whose home it sees (S9, F242)', () => {
  const acc = () => read('scripts/cynco-containment-acceptance.mjs')

  /** Every static import statement of a source, single-line or spread over lines, as `[statement, specifier]`. */
  const staticImports = (src: string): Array<[string, string]> =>
    [...src.matchAll(/^\s*(?:import|export)\s(?![^;\n]*\bimport\s*\()[\s\S]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)]
      .filter(m => !/^\s*(?:import|export)\s+type\s/.test(m[0]))
      .map(m => [m[0], (m[1] ?? m[2])!])

  it('imports nothing from engine/ statically except the mission predicate and the path helpers (a statement spread over lines included)', () => {
    // engine/realPath.js (listEntries, isLinkEntry, whyNotAtOwnPath) is allowed since the first live-fire
    // run (2026-11-24): the script's own removals and tree comparisons must tell a link by its folder's
    // listing, in the outer process too. It adds nothing to what is loaded before the self-check: the
    // module is already in the pinned set below (through ./cynco-spawn.mjs), declarations only, and it
    // starts no process and holds no state.
    const offenders = staticImports(acc()).filter(([, spec]) => /^\.\.\/engine\/(?!(?:missionEnv|realPath)\.js$)/.test(spec)).map(([s]) => s)
    expect(offenders).toEqual([])
    // The reading sees the multi-line form the script uses for node:fs, so it would see one for engine/ too.
    expect(staticImports("import {\n  a,\n  b,\n} from '../engine/containment.js'").map(([, s]) => s)).toEqual(['../engine/containment.js'])
  })

  it('what its static imports load before the self-check is a pinned set of engine modules with nothing but declarations at their top level', () => {
    // Through ./cynco-spawn.mjs the script loads engine modules before innerSelfCheck runs. Each was
    // read for this pin: its top level declares and exports, and calls nothing. A new module in this
    // set, or a top-level statement that does something, fails here and is read before it lands.
    const seen = new Set<string>()
    const fileOf = (spec: string, from: string): string | null => {
      if (!spec.startsWith('.')) return null
      const p = join(dirname(from), spec)
      for (const c of [p, p.replace(/\.js$/, '.ts')]) {
        try { if (statSync(c).isFile()) return c } catch { continue } // not this spelling: the next is tried
      }
      return null
    }
    const walk = (abs: string) => {
      if (seen.has(abs)) return
      seen.add(abs)
      for (const [, spec] of staticImports(readFileSync(abs, 'utf-8'))) {
        const next = fileOf(spec, abs)
        if (next) walk(next)
      }
    }
    walk(join(repoRoot, 'scripts', 'cynco-containment-acceptance.mjs'))
    const engineMods = [...seen].map(f => relative(repoRoot, f).split(sep).join('/')).filter(f => f.startsWith('engine/')).sort()
    expect(engineMods).toEqual(['engine/containment.ts', 'engine/missionEnv.ts', 'engine/paths.ts', 'engine/realPath.ts'])
    // A declaration, or a parameter of a signature wrapped onto its own line (`ctx: RunContainment | null = ...`).
    const DECLARATION = /^(?:import |export (?:function|async function|const|let|class|type|interface|\{|\*)|const |let |function |async function |class |type |interface |declare |[\w$]+\??: )/
    for (const mod of engineMods) {
      const lines = read(mod).split(/\r?\n/)
      const loose = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => /^[^\s}/*)\]]/.test(l) && !DECLARATION.test(l))
      expect(loose.map(([n, l]) => `${mod}:${n}: ${l}`), `${mod} has a top-level statement that is not a declaration`).toEqual([])
      const calls = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => /^(?:export )?(?:const|let) [\w$]+(?:: [^=]+)? = (?:await )?[\w$.]+\(/.test(l))
      expect(calls.map(([n, l]) => `${mod}:${n}: ${l}`), `${mod} calls a function at its top level`).toEqual([])
    }
  })

  it('innerMain calls innerSelfCheck before its first dynamic import', () => {
    const s = acc()
    const start = s.indexOf('async function innerMain(')
    expect(start).toBeGreaterThan(-1)
    const rest = s.slice(start)
    const end = rest.search(/\r?\n\}\r?\n/)
    expect(end).toBeGreaterThan(-1)
    const body = rest.slice(0, end)
    const check = body.indexOf('innerSelfCheck(')
    const firstImport = body.indexOf('await import(')
    expect(check).toBeGreaterThan(-1)
    expect(firstImport, 'innerMain imports no engine module at all').toBeGreaterThan(-1)
    expect(firstImport).toBeGreaterThan(check)
  })

  it('exports the real-profile flag and variable under the names the tests use', () => {
    // Built by concatenation, as containmentDefaultsAreNotLive.test.ts builds them: a test file may not spell either.
    const flag = '--real' + '-profile'
    const variable = 'LOCALCODE_CONTAINMENT_' + 'REAL_PROFILE'
    const s = acc()
    expect(s).toContain(`export const REAL_PROFILE_FLAG = '${flag}'`)
    expect(s).toContain(`export const REAL_PROFILE_VAR = '${variable}'`)
  })

  it('removes single entries only: no recursive remove in the script', () => {
    expect(acc().includes('rmSync(')).toBe(false)
  })
})

// ─── dispatch-mission.sh: an engine is confirmed dead only by tasklist's own answer (F242) ───────
describe('dispatch-mission.sh confirms a dead engine fail-closed (F242)', () => {
  const sh = () => read('scripts/dispatch-mission.sh').replace(/\r\n/g, '\n')
  const code = () => sh().split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const fnText = () => {
    const s = sh()
    const start = s.indexOf('engine_listing() {')
    expect(start, 'engine_listing() is gone').toBeGreaterThan(-1)
    return s.slice(start, s.indexOf('\n}\n', start) + 2)
  }

  it('no tasklist pipeline decides "dead" any more: both confirmations go through engine_listing', () => {
    const c = code()
    // A failed tasklist made `tasklist ... | grep -q` false, and the engine counted as gone.
    expect(c).not.toMatch(/tasklist[^\n]*\|\s*grep -q/)
    expect(c.match(/tasklist \/\//g)?.length, 'tasklist is run in one place only, inside engine_listing').toBe(1)
    const fn = c.slice(c.indexOf('dispatch_abandoned() {'), c.indexOf('trap dispatch_abandoned EXIT'))
    // Changed on purpose in wave 13b (B1-6): the confirmed pid is asked through engine_listing_confirmed, which is
    // engine_listing plus one reading (a reused pid of the confirmed bun.exe is gone), here and in the watcher.
    expect(fn).toContain('engine_listing_confirmed "$ENGINE_WINPID"')
    expect(fn).toContain('if [ "$ENGINE_LISTING" = gone ]; then break; fi')
    // Anything that is not "gone" and not "listed" posts not-confirmed-dead with its reason.
    expect(fn).toContain('elif [ "$ENGINE_LISTING" != gone ]; then')
    // Changed on purpose in wave 13c (C4): the trap now kills only after a `listed` answer, so an answer it could
    // not read may come with no taskkill before it; the reason no longer says "after taskkill".
    expect(fn).toContain('--engine-not-confirmed-dead "pid $ENGINE_WINPID asked for 10 s by the abandoned dispatch: ${ENGINE_LISTING#unknown: }"')
    const watcher = c.slice(c.indexOf('ENGINE_GONE=\n'), c.indexOf('--by dispatch-watcher >>'))
    expect(watcher).toContain('engine_listing_confirmed "$ENGINE_WINPID"')
    expect(watcher).toContain('if [ "$ENGINE_LISTING" = gone ]; then ENGINE_GONE=1; break; fi')
    expect(watcher).toContain('NOT_DEAD_WHY="pid $ENGINE_WINPID 60 s after mission end: ${ENGINE_LISTING#unknown: }"')
    // The function is defined before the trap that uses it and before the watcher subshell.
    expect(c.indexOf('engine_listing() {')).toBeLessThan(c.indexOf('dispatch_abandoned() {'))
  })

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
  /**
   * Runs a bash script from a file of its own, in `dir` when given (else a temporary folder of its own, removed
   * afterwards). Wave 13c: never through `bash -c`. Git Bash takes its command line through the MSYS runtime, which
   * cut a `-c` script at about 8 KB without a word (measured on this PC: 8,113 characters ran whole, 8,213 ran with
   * the end cut off and exited 0), so a lifted piece of the dispatch that grew past that ran truncated, and a case
   * could pass on a script that never ran its end.
   */
  // Wave 13d (P1): `env` adds variables to the environment the script starts with (a value a caller could carry).
  const runScript = (script: string, { timeout = 60_000, dir, env }: { timeout?: number; dir?: string; env?: Record<string, string> } = {}) => {
    const own = dir === undefined ? mkdtempSync(join(tmpdir(), 'cynco-w13c-sh-')) : null
    try {
      const file = join(dir ?? own!, 'script.sh')
      writeFileSync(file, script)
      return spawnSync(bash, [file.replace(/\\/g, '/')], { encoding: 'utf-8', timeout, windowsHide: true, env: env === undefined ? process.env : { ...process.env, ...env } })
    } finally {
      if (own !== null) rmSync(own, { recursive: true, force: true })
    }
  }
  it.skipIf(!existsSync(bash))('the scripts below run from a file, whole: a lifted script longer than a command line can carry still runs to its end', () => {
    const r = runScript(`# ${'x'.repeat(40_000)}\necho 'the end ran'\n`)
    expect(r.status, r.stderr).toBe(0)
    expect(String(r.stdout).replace(/\r/g, '')).toBe('the end ran\n')
  })
  it.skipIf(!existsSync(bash))('engine_listing: "gone" only on the no-match line; a failed, empty or unreadable tasklist is unknown', () => {
    const fn = fnText()
    const answer = (stub: string) => {
      // Under the dispatch script's own `set -euo pipefail`, called as a plain statement the way the
      // EXIT trap and the watcher call it: a failed tasklist must give an answer, not abort the caller.
      // Wave 19: tasklist is started under `timeout 20`, so `timeout` is a function too (it runs what it is handed),
      // or the real timeout would start the real tasklist past the stub.
      const script = `set -euo pipefail\ntimeout() { shift; "$@"; }\ntasklist() { ${stub}; }\n${fn}\nengine_listing 4242\nprintf '%s' "$ENGINE_LISTING"\n`
      const r = runScript(script, { timeout: 20_000 })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout
    }
    expect(answer("echo 'INFO: No tasks are running which match the specified criteria.'")).toBe('gone')
    // Wave 19 (plan P6 item 3): no English text is read. A tasklist that ran, exited 0 and printed no CSV row printed
    // its no-match line, in any language: gone. Changed on purpose: the ERROR line exiting 0 was "unknown" because it
    // was not the English line; tasklist exits 1 for a bad option (the case after it), so that answer stays unknown.
    expect(answer("echo 'INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgefuehrt.'")).toBe('gone')
    expect(answer("echo 'ERROR: Invalid argument/option'")).toBe('gone')
    expect(answer("echo 'ERROR: Invalid argument/option'; return 1")).toBe('unknown: tasklist could not be run or failed (exit 1)')
    expect(answer('return 124')).toBe('unknown: tasklist could not be run or failed (exit 124)')
    expect(answer(`printf '"bun.exe","4242","Console","1","10 K"\\r\\n'`)).toBe('listed')
    expect(answer('return 1')).toBe('unknown: tasklist could not be run or failed (exit 1)')
    expect(answer('return 127')).toBe('unknown: tasklist could not be run or failed (exit 127)')
    expect(answer(':')).toBe('unknown: tasklist printed nothing')
    expect(fnText()).not.toMatch(/No tasks are running|INFO:/)
    expect(fnText()).toContain('_el_out=$(timeout 20 tasklist //FI "PID eq $1" //NH //FO CSV 2>/dev/null) || _el_rc=$?')
    // Another pid's row is not this engine's row, and it is not a "no such task" answer either.
    expect(answer(`printf '"bun.exe","14242","Console","1","10 K"\\r\\n'`)).toBe('unknown: tasklist printed what this does not read')
    // Wave 13, D1: a row naming the pid with another image is neither the engine nor its absence.
    expect(answer(`printf '"sh.exe","4242","Console","1","10 K"\\r\\n'`)).toBe('unknown: pid 4242 is held by sh.exe, not bun.exe')
  })

  // Wave 13, D1 (rehearsal R1, finding F4). Measured on this PC (w13 scratch d1, SUMMARY.txt): right after
  // `bun engine/main.ts ... &` through the npm shim, /proc/$!/winpid names the forked bash for ~10 ms (gone at
  // once), then the shim's sh.exe (alive as bun.exe's parent for bun.exe's whole life), and bun.exe only from
  // ~0.1 s; the dispatch's own `$(cat ...)` on the next line read the sh.exe 40 times in 40. The old filter
  // `IMAGENAME eq bun.exe` answered "gone" for that live sh.exe, so a settle could close the baseline while the
  // engine and its tools lived: fail open.
  it('engine_listing asks tasklist by PID alone', () => {
    const fn = fnText()
    expect(fn).toContain('tasklist //FI "PID eq $1" //NH //FO CSV')
    expect(fn).not.toContain('IMAGENAME')
  })

  const onWindows = process.platform === 'win32'
  /** The Bun executable itself (not the npm shim), or null; asked only on Windows, only by the cases below. */
  const bunExe = (): string | null => {
    const r = spawnSync('bun -e "console.log(process.execPath)"', { encoding: 'utf-8', shell: true, timeout: 30_000, windowsHide: true })
    if (r.status !== 0) return null
    const p = String(r.stdout).trim().split(/\r?\n/).pop() ?? ''
    return p !== '' && existsSync(p) ? p : null
  }
  const runBash = (script: string, timeout = 120_000) => {
    const r = runScript(script, { timeout })
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0)
    return String(r.stdout).replace(/\r/g, '')
  }

  it.skipIf(!onWindows || !existsSync(bash))('engine_listing, run for real (Windows, Git Bash): a live bun.exe is listed, a live pid of another image is unknown and named, the same bun.exe killed is gone', async (ctx) => {
    const bun = bunExe()
    if (bun === null) return ctx.skip('bun is not on the PATH (or did not name its executable), so no bun.exe of the test\'s own could be started')
    const fn = fnText()
    const child = spawn(bun, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    try {
      const pid = child.pid!
      const live = runBash(`set -euo pipefail\n${fn}\nengine_listing ${pid}\nprintf 'bun=%s\\n' "$ENGINE_LISTING"\n`
        + `SELF=$(cat /proc/$$/winpid)\nengine_listing "$SELF"\nprintf 'self=%s\\nbash=%s\\n' "$SELF" "$ENGINE_LISTING"\n`
        + `engine_listing ${process.pid}\nprintf 'node=%s\\n' "$ENGINE_LISTING"\n`)
      const got = Object.fromEntries(live.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      expect(got.bun).toBe('listed')
      expect(got.bash).toBe(`unknown: pid ${got.self} is held by bash.exe, not bun.exe`)
      expect(got.node).toMatch(new RegExp(`^unknown: pid ${process.pid} is held by (?!bun\\.exe,)[^,]+, not bun\\.exe$`))
      child.kill()
      await exited
      // Asked again for a few seconds: only tasklist's own no-match line is "gone".
      const dead = runBash(`set -euo pipefail\n${fn}\nfor _ in 1 2 3 4 5 6 7 8 9 10; do engine_listing ${pid}; if [ "$ENGINE_LISTING" = gone ]; then break; fi; sleep 0.5; done\nprintf '%s' "$ENGINE_LISTING"\n`)
      expect(dead).toBe('gone')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }, 120_000)

  /** The lines between the engine's start and the wait for the model: the pid confirmation (D1). */
  const confirmBlock = () => {
    const s = sh()
    const startLine = 'ENGINE_PID=$!\n'
    const a = s.indexOf(startLine)
    const b = s.indexOf('echo "[dispatch] waiting for the model to load"')
    expect(a, 'ENGINE_PID=$! is gone').toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return s.slice(a + startLine.length, b)
  }

  it.skipIf(!onWindows || !existsSync(bash))('the pid confirmation, run for real (Windows, Git Bash): started through a shim shaped like the npm one, ENGINE_WINPID is the bun.exe, never the shim\'s sh.exe', (ctx) => {
    const bun = bunExe()
    if (bun === null) return ctx.skip('bun is not on the PATH (or did not name its executable), so no stand-in engine could be started')
    const dir = mkdtempSync(join(tmpdir(), 'cynco-d1-shim-'))
    try {
      // The npm shim's shape: a sh script that runs dirname, sed, uname and cygpath, then execs bun.exe.
      writeFileSync(join(dir, 'bun'), '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,:,:,g\')")\n'
        + 'case `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w "$basedir"`\n        fi\n    ;;\nesac\n'
        + `exec "${bun.replace(/\\/g, '/')}" "$@"\n`)
      const shimDir = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
      // Wave 13d (R8): process_started is lifted too: the confirmation reads the bun.exe's creation time.
      const out = runBash(`set -euo pipefail\nexport PATH="${shimDir}:$PATH"\n${fnText()}\n${shFn('process_started')}`
        + 'bun -e "setTimeout(()=>{},60000)" > /dev/null 2>&1 &\nENGINE_PID=$!\n'
        + confirmBlock()
        + 'printf \'winpid=%s\\n\' "${ENGINE_WINPID:-}"\n'
        + 'if [ -n "${ENGINE_WINPID:-}" ]; then printf \'row=%s\\n\' "$(tasklist //FI "PID eq $ENGINE_WINPID" //NH //FO CSV | tr -d \'\\r\')"; fi\n'
        // The test's own stand-in, ended once, with its tree, by the pid the lifted confirmation has just confirmed as
        // its bun.exe (with its creation time; the shim's sh.exe waits on it, so the number is still the stand-in's).
        // Changed on purpose in wave 24 (F255): a second taskkill of the same number followed, tens of ms after the
        // first had freed it, and an unconfirmed /proc read was killed too. A stand-in that was never confirmed (the
        // case then fails) is left to end by itself: it waits 60 s.
        + 'if [ -n "${ENGINE_WINPID:-}" ]; then taskkill //PID "$ENGINE_WINPID" //T //F > /dev/null 2>&1 || true; fi\n')
      const winpid = /^winpid=(\d*)$/m.exec(out)?.[1] ?? ''
      expect(winpid, out).not.toBe('')
      expect(/^row=(.*)$/m.exec(out)?.[1] ?? '', out).toMatch(new RegExp(`^"bun\\.exe","${winpid}",`))
      expect(out).toContain(`[dispatch] mission engine: bun.exe pid ${winpid}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('the pid is taken only once tasklist shows it as bun.exe, re-read for a bounded time, and the not-confirmed path is named', () => {
    const block = confirmBlock()
    const c = code()
    // No first read is ever taken as the engine's pid.
    expect(c).not.toMatch(/ENGINE_WINPID=\$\(cat /)
    expect(block).toContain('ENGINE_WINPID=\nENGINE_TREE_WINPID=\n')
    expect(block).toMatch(/for _ in \$\(seq 1 120\); do\n {2}_w=\$\(cat "\/proc\/\$ENGINE_PID\/winpid" 2>\/dev\/null \|\| true\)\n/)
    // Changed on purpose in wave 13d (R8): a listed bun.exe is taken only with its creation time, read in the same
    // round; one whose creation time cannot be read is not confirmed and the reads go on.
    expect(block).toContain('    engine_listing "$_w"\n    if [ "$ENGINE_LISTING" = listed ]; then\n      process_started "$_w"\n'
      + '      if [ -n "$PROCESS_STARTED" ]; then ENGINE_STARTED=$PROCESS_STARTED; ENGINE_WINPID=$_w; break; fi\n'
      + '      ENGINE_LISTING="unknown: pid $_w is a bun.exe, but $PROCESS_STARTED_WHY"\n    fi\n')
    expect(block).toContain('  sleep 0.25\ndone\n')
    // Wave 13d (R1): the test that decides whether the dispatch goes on is ENGINE_WINPID alone. Under the stubs the loop
    // makes three reads, so a condition that differs only past them (`|| [ "$ENGINE_PID_READS" -ge 120 ]`, which
    // would let a start whose 120 reads all failed go on with no pid) is seen only here.
    expect(block).toContain('\ndone\nif [ -n "$ENGINE_WINPID" ]; then\n  echo "[dispatch] mission engine: bun.exe pid $ENGINE_WINPID (tasklist confirmed it at read $ENGINE_PID_READS; created $ENGINE_STARTED in .NET ticks, UTC)"\nelse\n')
    expect(block.match(/\nif \[/g), 'one if at the top level of the block').toHaveLength(1)
    // Unconfirmed, it says so in one [dispatch] line and keeps the pid its tree can be stopped by. Changed on purpose
    // in wave 13b (B1-5, the owner's decision): the line is the dispatch's refusal, and the dispatch exits there.
    expect(block).toContain('echo "[dispatch] REFUSED: the mission engine\'s pid was never confirmed as bun.exe: ')
    expect(block).toContain('ENGINE_TREE_WINPID=$_w\n')
    // The trap stops that tree, only while the pid is still the shim's sh.exe or a bun.exe, and settles not confirmed dead.
    const trap = c.slice(c.indexOf('dispatch_abandoned() {'), c.indexOf('trap dispatch_abandoned EXIT'))
    expect(trap).toContain('elif [ -n "${ENGINE_TREE_WINPID:-}" ]; then\n    engine_listing "$ENGINE_TREE_WINPID"\n')
    expect(trap).toContain('listed|"unknown: pid $ENGINE_TREE_WINPID is held by sh.exe, not bun.exe") taskkill //PID "$ENGINE_TREE_WINPID" //T //F')
    expect(trap).toContain('--engine-not-confirmed-dead "the mission engine\'s Windows pid was never confirmed as bun.exe"')
    expect(trap.indexOf('engine_listing "$ENGINE_TREE_WINPID"')).toBeLessThan(trap.indexOf('if [ -n "${BASELINE_TAKEN:-}" ]; then'))
    // The watcher: no pid confirmed, no "gone": the baseline is settled not confirmed dead.
    const watcher = c.slice(c.indexOf('ENGINE_GONE=\n'), c.indexOf('--by dispatch-watcher >>'))
    expect(watcher).toContain('NOT_DEAD_WHY="the mission engine\'s Windows pid was never confirmed as bun.exe"')
    expect(c).not.toContain('was never read')
  })

  // ─── Wave 13b: the not-confirmed path is pinned by where it leads, by running the script's own text ──────
  // B1-2, B1-4, B1-5, B1-6. Each case lifts a piece of dispatch-mission.sh out of its text (never a copy kept
  // here) and runs it in bash with every outside program a function that records its arguments: taskkill,
  // tasklist, bun (the guard, the sandbox), powershell (the phone engine) and sleep. Nothing is started,
  // stopped or settled; the record says what the script WOULD have run.
  /** One function of the script, by name, or '' when the script has none of that name. */
  const shFn = (name: string) => {
    const s = sh()
    const start = s.indexOf(`\n${name}() {\n`)
    return start === -1 ? '' : s.slice(start + 1, s.indexOf('\n}\n', start) + 3)
  }
  /** The watcher's settle: from its ENGINE_GONE= to the guard status read after the post. */
  const watcherSettle = () => {
    const s = sh()
    const a = s.indexOf('  ENGINE_GONE=\n')
    const b = s.indexOf('  GUARD_NOW=', a)
    expect(a, 'the watcher\'s ENGINE_GONE= is gone').toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return s.slice(a, b)
  }
  /** tasklist as a function: what it prints for the pid it is asked about (`//FI "PID eq <n>"` is $2). */
  const TASKLIST = {
    gone: "echo 'INFO: No tasks are running which match the specified criteria.'",
    'sh.exe': `printf '"sh.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"`,
    'bun.exe': `printf '"bun.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"`,
    'notepad.exe': `printf '"notepad.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"`,
    // Wave 13c (C3): tasklist itself failing on every read.
    fails: 'return 1',
    // Wave 13c (C4): a live bun.exe until a taskkill was recorded, then tasklist's own no-match line.
    'bun.exe-until-killed': `if grep -q '^taskkill ' "$REC"; then echo 'INFO: No tasks are running which match the specified criteria.'; else printf '"bun.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"; fi`,
    // Wave 13d (R3): the npm shim's sh.exe until a taskkill was recorded, then tasklist's own no-match line.
    'sh.exe-until-killed': `if grep -q '^taskkill ' "$REC"; then echo 'INFO: No tasks are running which match the specified criteria.'; else printf '"sh.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"; fi`,
    // Wave 13d (R3): a live bun.exe until a taskkill was recorded, then tasklist failing.
    'bun.exe-until-killed-then-fails': `if grep -q '^taskkill ' "$REC"; then return 1; else printf '"bun.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"; fi`,
    // Wave 13d (R5): the dispatch's own shell asked about itself.
    'bash.exe': `printf '"bash.exe","%s","Console","1","10 K"\\r\\n' "\${2#PID eq }"`,
  } as const
  type Answer = keyof typeof TASKLIST
  /** Wave 13d (R8): the creation time (.NET ticks, UTC) every start-time read answers unless a case sets STARTED_NOW. */
  const STARTED = '638000000000000001'
  // The pids these cases hand the lifted text (123, 4242, 999, 888, 777 ...) are made up and reach only the recording
  // functions below: a real taskkill or kill of one would end whatever process has that number now (F255).
  const stubs = (answer: Answer) => [
    'REC="$REC_DIR/rec.txt"',
    ': > "$REC"',
    'rec() { printf \'%s\\n\' "$*" >> "$REC"; }',
    'taskkill() { rec "taskkill $*"; }',
    'bun() { rec "bun $*"; }',
    // Wave 13d (R8): a start-time read (Get-Process ... .StartTime) is recorded as `start-time <pid>` and answers
    // STARTED_NOW (default STARTED; `fail` is PowerShell failing); any other powershell is recorded whole.
    `powershell() { case "$*" in *".StartTime."*) if [[ $* =~ -Id[[:space:]]([0-9]+) ]]; then rec "start-time \${BASH_REMATCH[1]}"; fi; if [ "\${STARTED_NOW:-}" = fail ]; then return 1; fi; printf '%s\\r\\n' "\${STARTED_NOW:-${STARTED}}" ;; *) rec "powershell $*" ;; esac; }`,
    'sleep() { :; }',
    // Wave 19 (w13 check, ps-no-timeout): tasklist and the start-time read run under `timeout 20`; the stub runs what
    // it is handed, so the stubbed tasklist and powershell answer, never the real ones.
    'timeout() { shift; "$@"; }',
    // Wave 13c (C3): `kill -0` answers from KILL0 (alive unless it is set to dead) and any other kill is only
    // recorded, so the trap's end of the dispatch's own child is seen and never sent (the confirmation cases
    // run with ENGINE_PID=$$, the test's own bash).
    'kill() { if [ "${1:-}" = -0 ]; then [ "${KILL0:-alive}" = alive ]; else rec "kill $*"; fi; }',
    `tasklist() { ${TASKLIST[answer]}; }`,
  ].join('\n') + '\n'
  /** Runs a script under the stubs; the record follows the script's own output after a `--rec--` line. */
  const underStubs = (answer: Answer, body: string, { env }: { env?: Record<string, string> } = {}) => {
    // The record (and the watcher's driver log) live in a folder of the test's own, removed whatever the case did.
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w13b-'))
    try {
      const recDir = dir.replace(/\\/g, '/')
      // Wave 13d (R8): process_started (the creation-time read) is lifted with the two listing functions.
      const script = `set -euo pipefail\nREC_DIR='${recDir}'\n${stubs(answer)}${fnText()}\n${shFn('process_started')}${shFn('engine_listing_confirmed')}${body}`
      const r = runScript(script, { dir, env })
      const all = String(r.stdout).replace(/\r/g, '')
      const at = all.lastIndexOf('--rec--\n')
      return { status: r.status, stderr: String(r.stderr).replace(/\r/g, ''), out: at === -1 ? all : all.slice(0, at), rec: at === -1 ? [] : all.slice(at + 8).split('\n').filter(Boolean) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const showRec = 'printf -- \'--rec--\\n\'; command cat "$REC"\n'
  /** The trap, run as it runs on an exit before the driver: a baseline, a sandbox and a stopped phone engine to give back. */
  // Wave 13c: `dead: true` makes `kill -0` of the dispatch's own child answer that it is not running (C3).
  // Wave 13d: a dispatch that stopped before its engine was started is no longer built here with `unset ENGINE_PID`
  // (P1): runTrapFromStart runs the script's own start values instead. `started` is the creation time recorded when
  // the pid was confirmed (ENGINE_STARTED) and `now` what a start-time read answers at the trap (R8).
  const runTrap = (answer: Answer, { winpid, tree, enginePid = '123', dead = false, started = STARTED, now }: { winpid: string; tree: string; enginePid?: string; dead?: boolean; started?: string; now?: string }) => underStubs(answer,
    `RUN_ID=m-w13b\nBASELINE_TAKEN=1\nSANDBOX_CREATED=1\nPHONE_ENGINE_WAS_RUNNING=1\nENGINE_PID=${enginePid}\nENGINE_WINPID=${winpid}\nENGINE_TREE_WINPID=${tree}\nENGINE_STARTED=${started}\n`
    + `${now === undefined ? '' : `STARTED_NOW=${now}\n`}${dead ? 'KILL0=dead\n' : ''}${shFn('dispatch_abandoned')}dispatch_abandoned\n${showRec}`)
  /** The variables the trap and the confirmed-pid reads route on, each given an empty start value before the trap is set. */
  const START_VALUE_NAMES = ['SANDBOX_CREATED', 'BASELINE_TAKEN', 'PHONE_ENGINE_WAS_RUNNING', 'ENGINE_PID', 'ENGINE_WINPID', 'ENGINE_TREE_WINPID', 'ENGINE_STARTED']
  /** Wave 13d (P1): every top-level line of the script before `trap dispatch_abandoned EXIT` that assigns one of them, as written. */
  const startValues = () => {
    const s = sh()
    const trapAt = s.indexOf('\ntrap dispatch_abandoned EXIT\n')
    expect(trapAt, 'trap dispatch_abandoned EXIT is gone').toBeGreaterThan(-1)
    const assigns = new RegExp(`^(?:${START_VALUE_NAMES.join('|')})=`)
    return s.slice(0, trapAt).split('\n').filter(l => assigns.test(l))
  }
  /**
   * Wave 13d (P1): the trap of a dispatch that stopped after its baseline and before its engine was started, run from
   * the script's OWN start values (lifted from its text) with `env` in the environment the script starts with; only
   * what the script sets between `pre` and the engine's start (the run id, the baseline, the sandbox, a stopped phone
   * engine) is set by the case. `lift: false` leaves the start values out: the control that shows `env` reaches it.
   */
  const runTrapFromStart = (answer: Answer, env: Record<string, string>, { lift = true } = {}) => underStubs(answer,
    `${lift ? `${startValues().join('\n')}\n` : ''}RUN_ID=m-w13b\nBASELINE_TAKEN=1\nSANDBOX_CREATED=1\nPHONE_ENGINE_WAS_RUNNING=1\n`
    + `${shFn('dispatch_abandoned')}dispatch_abandoned\n${showRec}`, { env })
  // Changed on purpose in wave 19b: every Bun start of the dispatch passes --no-install (Bun never fetches a package by
  // itself), so the stub records `bun --no-install scripts/...`; every needle on a Bun start in this file follows it.
  const posts = (rec: string[]) => rec.filter(l => l.startsWith('bun --no-install scripts/cynco-guard.mjs post '))
  const NOT_CONFIRMED_POST = 'bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned --engine-not-confirmed-dead the mission engine\'s Windows pid was never confirmed as bun.exe'

  it.skipIf(!existsSync(bash))('B1-2 (b): the trap settles an unconfirmed engine as not confirmed dead whatever tasklist answers for the tree pid, "gone" included', () => {
    for (const answer of ['gone', 'sh.exe', 'bun.exe', 'notepad.exe'] as const) {
      const r = runTrap(answer, { winpid: '', tree: '4242' })
      expect(r.status, `${answer}: ${r.stderr}`).toBe(0)
      expect(posts(r.rec), answer).toEqual([NOT_CONFIRMED_POST])
      // The tree is stopped by that pid only while it is the shim's sh.exe or a bun.exe.
      const killed = r.rec.filter(l => l.startsWith('taskkill '))
      expect(killed, answer).toEqual(answer === 'sh.exe' || answer === 'bun.exe' ? ['taskkill //PID 4242 //T //F'] : [])
      expect(r.rec, answer).toContain('bun --no-install scripts/cynco-sandbox.mjs release m-w13b')
      expect(r.rec, answer).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cynco-services.ps1 start engine')
    }
  })

  it.skipIf(!existsSync(bash))('B1-2 (b): a confirmed engine that reads gone takes the plain post', () => {
    const r = runTrap('gone', { winpid: '4242', tree: '4242' })
    expect(r.status, r.stderr).toBe(0)
    // Changed on purpose in wave 13c (C4): the confirmed pid is asked before any kill, and a pid that reads gone
    // is not killed (Windows may already have given it to another program); it was killed with //T first before.
    expect(r.rec.filter(l => l.startsWith('taskkill ') || l.startsWith('kill '))).toEqual([])
    expect(posts(r.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned'])
  })

  it('B1-2 (c): ENGINE_WINPID is assigned in exactly one place besides its two empty initialisations, and read nowhere else but as $ENGINE_WINPID', () => {
    const c = code()
    expect(c.match(/(?<![\w$])ENGINE_WINPID=[^\s;]*/g)).toEqual(['ENGINE_WINPID=', 'ENGINE_WINPID=', 'ENGINE_WINPID=$_w'])
    // Every other mention is a read ($ENGINE_WINPID or ${ENGINE_WINPID...}): no read -r, printf -v, declare or export of it.
    for (const m of c.matchAll(/(?<!\w)ENGINE_WINPID\b(=?)/g)) {
      const before = c[m.index! - 1]
      expect(before === '$' || before === '{' || m[1] === '=', c.slice(Math.max(0, m.index! - 30), m.index! + 30)).toBe(true)
    }
  })

  /**
   * The confirmation block run as the dispatch runs it, with three reads. `reads` is what /proc/<pid>/winpid
   * prints on every read: '4242', or '' when no pid can ever be read (wave 13c, C2).
   */
  const runConfirmation = (answer: Answer, reads = '4242') => underStubs(answer,
    'seq() { command seq "$1" 3; }\n'
    + `cat() { if [ "\${1:-}" = "/proc/$ENGINE_PID/winpid" ]; then ${reads === '' ? ':' : `echo ${reads}`}; else command cat "$@"; fi; }\n`
    + 'RUN_ID=m-w13b\nBASELINE_TAKEN=1\nSANDBOX_CREATED=1\nPHONE_ENGINE_WAS_RUNNING=1\n'
    + shFn('dispatch_abandoned')
    + 'on_exit() { _rc=$?; printf \'winpid=%s\\ntree=%s\\nreads=%s\\n\' "${ENGINE_WINPID:-}" "${ENGINE_TREE_WINPID:-}" "${ENGINE_PID_READS:-}"; dispatch_abandoned; ' + showRec.trim() + '; exit $_rc; }\n'
    + 'trap on_exit EXIT\n'
    + 'ENGINE_PID=$$\n'
    + confirmBlock()
    + 'echo AFTER-THE-CONFIRMATION\n')

  it.skipIf(!existsSync(bash))('B1-2 (a): never confirmed, ENGINE_WINPID stays empty, ENGINE_TREE_WINPID keeps the last pid read, and the never-confirmed line is printed', () => {
    const r = runConfirmation('sh.exe')
    expect(r.out).toContain('winpid=\ntree=4242\nreads=3\n')
    expect(r.stderr + r.out).toContain('the mission engine\'s pid was never confirmed as bun.exe: 3 read(s) of /proc/')
    expect(r.stderr + r.out).toContain(', the last 4242 (pid 4242 is held by sh.exe, not bun.exe)')
  })

  it.skipIf(!existsSync(bash))('B1-5: never confirmed, the dispatch refuses there and exits through the trap: the tree stopped by its pid, the baseline settled not confirmed dead, the sandbox released, the phone engine started again', () => {
    // Changed on purpose in wave 13d (R3): the trap now asks the tree's pid again after its taskkill and ends its own
    // child when the pid is still the shim's sh.exe or a bun.exe, so the tree here is one its taskkill ends (the
    // shim's sh.exe until the kill). A tree that outlives its taskkill is the R3 case below.
    const r = runConfirmation('sh.exe-until-killed')
    expect(r.status, r.out).toBe(1)
    expect(r.out, 'the dispatch went on past the confirmation').not.toContain('AFTER-THE-CONFIRMATION')
    expect(r.stderr).toMatch(/^\[dispatch\] REFUSED: the mission engine's pid was never confirmed as bun\.exe: /m)
    expect(r.rec).toEqual([
      'taskkill //PID 4242 //T //F',
      NOT_CONFIRMED_POST,
      'bun --no-install scripts/cynco-sandbox.mjs release m-w13b',
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cynco-services.ps1 start engine',
    ])
    expect(r.out).toContain('[dispatch] stopped before the mission started — the mission engine\'s tree is stopped by pid 4242 (its own pid was never confirmed)\n')
    // The same for a pid read that never became anything this reads (the engine gone before it was seen).
    const gone = runConfirmation('gone')
    expect(gone.status).toBe(1)
    expect(gone.out).not.toContain('AFTER-THE-CONFIRMATION')
    expect(posts(gone.rec)).toEqual([NOT_CONFIRMED_POST])
  })

  it.skipIf(!existsSync(bash))('B1-5: a confirmed start goes on past the confirmation', () => {
    const r = runConfirmation('bun.exe')
    expect(r.status, r.stderr).toBe(0)
    // Changed on purpose in wave 13d (R8): the confirmation also reads the bun.exe's creation time, and the line says it.
    expect(r.out).toContain(`[dispatch] mission engine: bun.exe pid 4242 (tasklist confirmed it at read 1; created ${STARTED} in .NET ticks, UTC)\n`)
    expect(r.out).toContain('AFTER-THE-CONFIRMATION\n')
  })

  it('B1-4: the watcher is reached only with a confirmed pid, so mission-end is handed that pid and never 0 for an unconfirmed one', () => {
    const c = code()
    const block = confirmBlock()
    // The never-confirmed branch ends the dispatch before anything after it (the watcher included) runs.
    expect(block).toMatch(/\nelse\n {2}echo "\[dispatch\] REFUSED: the mission engine's pid was never confirmed as bun\.exe: [^\n]*" >&2\n {2}exit 1\nfi\n+$/)
    expect(c.indexOf('bun --no-install scripts/cynco-mission-end.mjs')).toBeGreaterThan(c.indexOf('echo "[dispatch] waiting for the model to load"'))
    // Changed on purpose in wave 13d (R8): the creation time read at the confirmation goes with the pid.
    expect(c).toContain('bun --no-install scripts/cynco-mission-end.mjs --engine-pid "$ENGINE_WINPID" --engine-started "$ENGINE_STARTED" ${CYNCO_SKIP_IDLE_ENGINE:+--skip-idle}')
    expect(c).not.toContain('--engine-pid "${ENGINE_WINPID:-0}"')
  })

  /** The watcher's settle run for one confirmed (or empty) pid; the driver log's lines follow a `--log--` line. */
  // Wave 13d (R8): `started` is ENGINE_STARTED (the creation time read at the confirmation), `now` what a start-time read answers.
  const runWatcher = (answer: Answer, winpid: string, { started = STARTED, now }: { started?: string; now?: string } = {}) => {
    const r = underStubs(answer, `DRIVER_LOG="$REC_DIR/driver.log"\n: > "$DRIVER_LOG"\nRUN_ID=m-w13b\nENGINE_WINPID=${winpid}\nENGINE_STARTED=${started}\n${now === undefined ? '' : `STARTED_NOW=${now}\n`}${watcherSettle()}printf -- '--log--\\n'; command cat "$DRIVER_LOG"\n${showRec}`)
    const at = r.out.indexOf('--log--\n')
    return { ...r, log: at === -1 ? [] : r.out.slice(at + 8).split('\n').filter(Boolean) }
  }
  const REUSED = 'pid 4242 is now notepad.exe: the engine\'s bun.exe has ended and its pid was reused'
  /** Wave 13d (R8): the same pid held by another bun.exe, told apart by its creation time. */
  const REUSED_BY_BUN = `pid 4242 is now another bun.exe (created 638000000000000777; the engine was created ${STARTED}): the engine's bun.exe has ended and its pid was reused`

  it.skipIf(!existsSync(bash))('B1-6: for the CONFIRMED pid, "held by <image>" is the engine gone (a process never changes its image), said in a line, in the trap and in the watcher', () => {
    const trap = runTrap('notepad.exe', { winpid: '4242', tree: '4242' })
    expect(trap.status, trap.stderr).toBe(0)
    expect(trap.out).toContain(`[dispatch] ${REUSED}\n`)
    expect(posts(trap.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned'])
    // Wave 13c (C4): the program that now holds the pid is not killed.
    expect(trap.rec.filter(l => l.startsWith('taskkill ') || l.startsWith('kill '))).toEqual([])
    const w = runWatcher('notepad.exe', '4242')
    expect(w.status, w.stderr).toBe(0)
    expect(w.log).toEqual([`[dispatch] ${REUSED}`])
    expect(posts(w.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher'])
    // The shim's sh.exe is another image too: for the confirmed bun.exe's pid it can only be a reuse.
    expect(posts(runWatcher('sh.exe', '4242').rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher'])
  })

  it.skipIf(!existsSync(bash))('B1-6 and R8: a bun.exe with the engine\'s creation time still listed latches after the wait; ANOTHER bun.exe on the pid (another creation time) is the engine gone; an empty pid is never confirmed', () => {
    const w = runWatcher('bun.exe', '4242')
    expect(posts(w.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher --engine-not-confirmed-dead pid 4242 still listed 60 s after mission end'])
    expect(w.log).toEqual([])
    // Changed on purpose in wave 13d (R8): a reuse by another bun.exe was read as listed and latched (a false latch);
    // its creation time tells it from the engine now, so it is the engine gone, said in the reuse line.
    const other = runWatcher('bun.exe', '4242', { now: '638000000000000777' })
    expect(other.log).toEqual([`[dispatch] ${REUSED_BY_BUN}`])
    expect(posts(other.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher'])
    // A creation time that cannot be read is not the engine gone: it latches with the reason.
    const unread = runWatcher('bun.exe', '4242', { now: 'fail' })
    expect(posts(unread.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher --engine-not-confirmed-dead pid 4242 60 s after mission end: pid 4242 is a bun.exe, but its start time could not be read (PowerShell exit 1)'])
    const none = runWatcher('notepad.exe', '')
    expect(posts(none.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-watcher --engine-not-confirmed-dead the mission engine\'s Windows pid was never confirmed as bun.exe'])
    // Wave 13d: three of these runs go through the watcher's whole 30-round wait in Git Bash (a start-time read in
    // each round), which takes longer than the default 5 s.
  }, 60_000)

  it.skipIf(!existsSync(bash))('B1-6: a pid that is not the confirmed one is never gone by "held by": engine_listing_confirmed answers what engine_listing answers', () => {
    const ask = (winpid: string) => underStubs('sh.exe', `ENGINE_WINPID=${winpid}\nengine_listing_confirmed 4242\nprintf '%s|%s\\n' "$ENGINE_LISTING" "$ENGINE_REUSED_LINE"\n${showRec}`)
    expect(ask('').out).toBe('unknown: pid 4242 is held by sh.exe, not bun.exe|\n')
    expect(ask('999').out).toBe('unknown: pid 4242 is held by sh.exe, not bun.exe|\n')
    expect(ask('4242').out).toBe('gone|pid 4242 is now sh.exe: the engine\'s bun.exe has ended and its pid was reused\n')
  })

  it('B1-6: "confirmed" is ENGINE_WINPID, and only the two confirmed-pid loops read a reuse as gone', () => {
    const c = code()
    const fn = shFn('engine_listing_confirmed')
    expect(fn).toContain('if [ -n "${ENGINE_WINPID:-}" ] && [ "$1" = "$ENGINE_WINPID" ]; then')
    expect(c.match(/engine_listing_confirmed "[^"]*"/g)).toEqual(['engine_listing_confirmed "$ENGINE_WINPID"', 'engine_listing_confirmed "$ENGINE_WINPID"'])
    const trap = c.slice(c.indexOf('dispatch_abandoned() {'), c.indexOf('trap dispatch_abandoned EXIT'))
    expect(trap).toContain('    engine_listing "$ENGINE_TREE_WINPID"\n')
  })

  // ─── Wave 13c: what the second checks of wave 13b left (C1 to C5) ──────────────────────────────────────
  const trapText = () => { const c = code(); return c.slice(c.indexOf('dispatch_abandoned() {'), c.indexOf('trap dispatch_abandoned EXIT')) }
  const PLAIN_POST = 'bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned'
  const RELEASE = 'bun --no-install scripts/cynco-sandbox.mjs release m-w13b'
  const PHONE_START = 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cynco-services.ps1 start engine'
  const kills = (rec: string[]) => rec.filter(l => l.startsWith('taskkill ') || l.startsWith('kill '))

  // Wave 13d (P1): what makes the routing condition true at those exits is the script's own start values, so the case
  // runs them, lifted from its text, with stray values of the engine's variables in the environment it starts with.
  // Built with `unset ENGINE_PID` instead (wave 13c), a mutant of the start value itself (`ENGINE_PID=1`, or the line
  // deleted while a caller exports ENGINE_PID) passed every case and would latch, and kill an MSYS process that is not
  // the dispatch's child, on every dispatch that stops after its baseline and before its engine is started.
  const STRAY = { ENGINE_PID: '999', ENGINE_WINPID: '888', ENGINE_TREE_WINPID: '777', ENGINE_STARTED: '1' }
  it.skipIf(!existsSync(bash))('C1 and P1: a dispatch that stops after its baseline and before any engine was started, run from the script\'s own start values with stray values exported, takes the plain post, stops nothing, releases the sandbox and starts the phone engine again', () => {
    // The exits between `pre` and `bun engine/main.ts &`: the sandbox not made, the engines or llama-servers not
    // listed, a llama-server that survived its kill. No engine was ever started, so nothing is unconfirmed: a
    // not-confirmed-dead post here would write the integrity latch for nothing.
    for (const answer of ['gone', 'bun.exe', 'sh.exe'] as const) {
      const r = runTrapFromStart(answer, STRAY)
      expect(r.status, `${answer}: ${r.stderr}`).toBe(0)
      expect(r.rec, answer).toEqual([PLAIN_POST, RELEASE, PHONE_START])
      expect(r.out, answer).toContain('[dispatch] stopped before the mission started — starting the phone engine again\n')
      expect(r.out, answer).not.toContain('999')
      // Wave 19 (the w13 check's route-elif): the trap's whole output, so a routing that takes another branch (one
      // that says "no Windows pid of the mission engine was ever read" when no engine was started) is seen.
      expect(r.out.split('\n').filter(Boolean), answer).toEqual(['[dispatch] stopped before the mission started — starting the phone engine again'])
    }
    // The control: the stray value does reach the script, and without the start values the trap would take it.
    const control = runTrapFromStart('gone', { ENGINE_PID: '999' }, { lift: false })
    expect(control.rec).toEqual(['kill -9 999', NOT_CONFIRMED_POST, RELEASE, PHONE_START])
    // The routing condition's text: both halves.
    expect(trapText()).toContain('\n    if [ -n "${ENGINE_PID:-}" ] && [ -z "${ENGINE_WINPID:-}" ]; then\n      bun --no-install scripts/cynco-guard.mjs post "$RUN_ID" --by dispatch-abandoned --engine-not-confirmed-dead "the mission engine\'s Windows pid was never confirmed as bun.exe"')
  })

  it('P1: the start values, as text: each variable the trap routes on is emptied before the trap is set, and ENGINE_PID is otherwise set only to the engine\'s $!', () => {
    expect(startValues()).toEqual(START_VALUE_NAMES.map(n => `${n}=`))
    const c = code()
    expect(c.slice(0, c.indexOf('\ntrap dispatch_abandoned EXIT\n'))).toContain('\nENGINE_PID=\nENGINE_WINPID=\nENGINE_TREE_WINPID=\nENGINE_STARTED=\n')
    expect(c.match(/(?<![\w$])ENGINE_PID=[^\s;]*/g)).toEqual(['ENGINE_PID=', 'ENGINE_PID=$!'])
    // No other way of giving it a value: an export, a declaration, a default expansion, a read or a printf -v.
    expect(c).not.toMatch(/(?:^|[;&|(]|\bthen|\bdo|\belse)\s*(?:export|declare|typeset|readonly|local|read|unset)\s[^\n]*\bENGINE_PID\b|ENGINE_PID:?=[^\s;$]|printf -v ENGINE_PID\b|\$\{ENGINE_PID:?=/m)
    expect(c.match(/(?<![\w$])ENGINE_STARTED=[^\s;]*/g)).toEqual(['ENGINE_STARTED=', 'ENGINE_STARTED=$PROCESS_STARTED'])
    // Wave 19 (the w13 check's P1-hole): every free occurrence (not read as $NAME or ${NAME...}) of each routing name,
    // to the end of its line, so `ENGINE_PID+=1`, `(( ENGINE_PID = 1 ))` and `let ENGINE_PID+=1` are seen too.
    const free = (name: string) => [...c.matchAll(new RegExp(`(?<![\\w$])${name}\\b`, 'g'))]
      .filter(m => c[m.index! - 1] !== '{' && c[m.index! - 1] !== '$')
      .map(m => c.slice(m.index!, c.indexOf('\n', m.index!)))
    expect(free('ENGINE_PID')).toEqual(['ENGINE_PID=', 'ENGINE_PID=$!'])
    expect(free('ENGINE_TREE_WINPID')).toEqual(['ENGINE_TREE_WINPID=', 'ENGINE_TREE_WINPID=', 'ENGINE_TREE_WINPID=$_w'])
    expect(free('ENGINE_STARTED')).toEqual(['ENGINE_STARTED=', 'ENGINE_STARTED=$PROCESS_STARTED; ENGINE_WINPID=$_w; break; fi'])
    for (const mutant of ['ENGINE_PID+=1', '(( ENGINE_PID = 1 ))', 'let ENGINE_PID+=1']) {
      const m = c.replace('\nENGINE_STARTED=\n', `\nENGINE_STARTED=\n${mutant}\n`)
      const got = [...m.matchAll(/(?<![\w$])ENGINE_PID\b/g)].filter(x => m[x.index! - 1] !== '{' && m[x.index! - 1] !== '$').map(x => m.slice(x.index!, m.indexOf('\n', x.index!)))
      expect(got, mutant).not.toEqual(['ENGINE_PID=', 'ENGINE_PID=$!'])
    }
  })

  // Wave 19 (the w13 check's tree-after-child-gone): once the dispatch's own child has ended, the last pid read can only
  // be gone or a stranger's (the shim's sh.exe lives exactly as long as bun.exe), so nothing is stopped by it.
  it.skipIf(!existsSync(bash))('tree-after-child-gone: an unconfirmed tree pid is stopped only while the dispatch\'s own child still runs', () => {
    for (const answer of ['bun.exe', 'sh.exe'] as const) {
      const r = runTrap(answer, { winpid: '', tree: '4242', dead: true })
      expect(r.status, `${answer}: ${r.stderr}`).toBe(0)
      expect(kills(r.rec), answer).toEqual([])
      expect(r.out, answer).toContain('[dispatch] stopped before the mission started — the dispatch\'s own child (shell pid 123) has ended, so pid 4242 can no longer be the mission engine\'s tree; nothing was stopped by pid\n')
      expect(posts(r.rec), answer).toEqual([NOT_CONFIRMED_POST])
    }
    // The child still running: the tree is stopped by its pid as before.
    expect(kills(runTrap('bun.exe-until-killed', { winpid: '', tree: '4242' }).rec)).toEqual(['taskkill //PID 4242 //T //F'])
  })

  // ─── Wave 19: decision sheet item 25 and plan P6 PART A in the dispatch ──────────────────────────────────────
  /** The script's lines from its first line to `# --- containment`, which hold the mark's handling and the log check. */
  const headText = () => { const s = sh(); return s.slice(0, s.indexOf('# --- containment (F242)')) }
  const runHead = (env: Record<string, string>, dir?: string) => {
    // Lifted from `AUTHOR_CHECK_MARK=` to the containment heading, with the script's arguments set; `bun` is a stub.
    const s = headText()
    const body = s.slice(s.indexOf('\nBRIEF=${1:?'))
    return runScript(`set -euo pipefail\nset -- /c/x/brief.txt m /c/x 60 ""\nbun() { echo "bun $*"; }\n${body}\necho "HEAD-PASSED mark=$AUTHOR_CHECK_MARK env=\${LOCALCODE_MISSION_AUTHOR_CHECK-unset}"\n`, { env, ...(dir ? { dir } : {}) })
  }

  it.skipIf(!existsSync(bash))('item 25: the mark is read once and taken out of the dispatch\'s environment; a mark that is not "1" refuses before anything', () => {
    const marked = runHead({ LOCALCODE_MISSION_AUTHOR_CHECK: '1', ENGINE_LOG: '/c/x/no-such-engine.log', DRIVER_LOG: '/c/x/no-such-driver.log', IDLE_LOG: '/c/x/no-such-idle.log' })
    expect(marked.status, marked.stderr).toBe(0)
    expect(String(marked.stdout)).toContain('HEAD-PASSED mark=1 env=unset')
    const none = runHead({ ENGINE_LOG: '/c/x/no-such-engine.log', DRIVER_LOG: '/c/x/no-such-driver.log', IDLE_LOG: '/c/x/no-such-idle.log' })
    expect(String(none.stdout)).toContain('HEAD-PASSED mark= env=unset')
    const wrong = runHead({ LOCALCODE_MISSION_AUTHOR_CHECK: 'yes', ENGINE_LOG: '/c/x/no-such-engine.log', DRIVER_LOG: '/c/x/no-such-driver.log' })
    expect(wrong.status).toBe(1)
    expect(String(wrong.stdout)).not.toContain('HEAD-PASSED')
    expect(String(wrong.stderr)).toContain('[dispatch] REFUSED: the authoring dispatch\'s mark (LOCALCODE_MISSION_AUTHOR_CHECK) is "yes", not "1" — nothing was dispatched')
  })

  it('item 25: only the driver is handed the mark, on its own line; the engine\'s start never names it', () => {
    const c = code()
    expect(c.indexOf('unset LOCALCODE_MISSION_AUTHOR_CHECK')).toBeGreaterThan(-1)
    expect(c.indexOf('unset LOCALCODE_MISSION_AUTHOR_CHECK')).toBeLessThan(c.indexOf('bun --no-install scripts/cynco-sandbox.mjs mint'))
    expect(c.match(/LOCALCODE_MISSION_AUTHOR_CHECK/g)).toHaveLength(4)
    const driver = c.slice(c.indexOf('CYNCO_CHECK_TIMEOUT_MS="$CYNCO_CHECK_TIMEOUT_MS" \\'), c.indexOf('  bun --no-install scripts/cynco-mission-driver.mjs'))
    expect(driver).toContain('LOCALCODE_MISSION_AUTHOR_CHECK="$AUTHOR_CHECK_MARK" \\\n')
    const engine = c.slice(c.indexOf('LOCALCODE_APPROVE_ALL=true \\'), c.indexOf('  bun --no-install engine/main.ts > "$ENGINE_LOG" 2>&1 &'))
    expect(engine).not.toContain('AUTHOR_CHECK')
    // Plan P6 item 5: the driver is handed the confirmed engine's pid and creation time for its teardown.
    expect(driver).toContain('CYNCO_ENGINE_WINPID="$ENGINE_WINPID" \\\nCYNCO_ENGINE_STARTED="$ENGINE_STARTED" \\\n')
  })

  it.skipIf(!existsSync(bash))('plan P6 item 4 (R4-3): a log the dispatch would truncate that already exists is refused by name before anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w19-logs-'))
    try {
      const d = dir.replace(/\\/g, '/')
      writeFileSync(join(dir, 'engine_old.log'), 'evidence')
      const free = { ENGINE_LOG: `${d}/engine_new.log`, DRIVER_LOG: `${d}/driver_new.log`, IDLE_LOG: `${d}/idle_new.log` }
      expect(String(runHead(free).stdout)).toContain('HEAD-PASSED')
      for (const [key, skip] of [['ENGINE_LOG', ''], ['DRIVER_LOG', ''], ['IDLE_LOG', '']] as const) {
        const r = runHead({ ...free, [key]: `${d}/engine_old.log`, ...(skip ? { CYNCO_SKIP_IDLE_ENGINE: skip } : {}) })
        expect(r.status, key).toBe(1)
        expect(String(r.stdout), key).not.toContain('HEAD-PASSED')
        expect(String(r.stderr), key).toContain(`[dispatch] REFUSED: ${d}/engine_old.log already exists, and this dispatch would overwrite it`)
      }
      // A dispatch whose caller owns the dashboard boots no idle engine, so the idle log is not asked about.
      expect(String(runHead({ ...free, IDLE_LOG: `${d}/engine_old.log`, CYNCO_SKIP_IDLE_ENGINE: '1' }).stdout)).toContain('HEAD-PASSED')
      expect(readFileSync(join(dir, 'engine_old.log'), 'utf8')).toBe('evidence')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const c = code()
    expect(c.indexOf('log_collision "$ENGINE_LOG" "$DRIVER_LOG"')).toBeLessThan(c.indexOf('bun --no-install scripts/cynco-sandbox.mjs mint'))
    expect(c.match(/IDLE_LOG=\$\{IDLE_LOG:-/g)).toHaveLength(1)
  })

  // Plan P6 item 8: two branches no case ran, each lifted from the script's text and run under the stubs.
  it.skipIf(!existsSync(bash))('P6 item 8: the model-load wait refuses on the engine\'s [containment] refused: line (and its FATAL line), and goes on at the template line', () => {
    const s = sh()
    const a = s.indexOf('for _ in $(seq 1 120); do\n  if grep -q "Chat template supports native tool calls"')
    const loop = s.slice(a, s.indexOf('\ndone\n', a) + 6)
    expect(a).toBeGreaterThan(-1)
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w19-load-'))
    try {
      const log = join(dir, 'engine.log').replace(/\\/g, '/')
      const run = (text: string) => {
        writeFileSync(log, text)
        return underStubs('gone', `ENGINE_LOG='${log}'\n${loop}echo AFTER-THE-WAIT\n${showRec}`)
      }
      const refused = run('[boot] x\r\n[containment] refused: containment: the sandbox root C:/s does not exist\r\n')
      expect(refused.status).toBe(1)
      expect(refused.out).not.toContain('AFTER-THE-WAIT')
      expect(refused.stderr).toBe(`[dispatch] REFUSED: containment: the sandbox root C:/s does not exist — nothing was dispatched (engine log ${log})\n`)
      const fatal = run('[llama-cpp] FATAL: refused by the host check\n')
      expect(fatal.status).toBe(1)
      expect(fatal.stderr).toBe(`[dispatch] the engine failed to start: [llama-cpp] FATAL: refused by the host check — see ${log}\n`)
      const ok = run('[llama-cpp] Chat template supports native tool calls\n')
      expect(ok.status, ok.stderr).toBe(0)
      expect(ok.out).toContain('AFTER-THE-WAIT')
      expect(ok.rec).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!existsSync(bash))('P6 item 8: after its settle, the watcher says a latch it finds, verifies the audit for the run and releases the sandbox, each into the driver log', () => {
    const s = sh()
    const a = s.indexOf('  GUARD_NOW=$(bun --no-install scripts/cynco-guard.mjs status --quiet')
    const tail = s.slice(a, s.indexOf('  case "$(printf', a))
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w19-watch-'))
    try {
      const log = join(dir, 'driver.log').replace(/\\/g, '/')
      for (const [status, line] of [['clear', null], ['latched: HALT.json set by dispatch-watcher', '[dispatch] integrity latch present: latched: HALT.json set by dispatch-watcher'], ['', '[dispatch] integrity latch present: the integrity guard did not answer']] as const) {
        writeFileSync(log, '')
        const r = underStubs('gone', `RUN_ID=m-w19\nDRIVER_LOG='${log}'\nbun() { rec "bun $*"; if [ "$3" = status ]; then printf '%s\\r\\n' '${status}'; fi; }\n${tail}${showRec}`)
        expect(r.status, r.stderr).toBe(0)
        expect(r.rec).toEqual(['bun --no-install scripts/cynco-guard.mjs status --quiet', 'bun --no-install scripts/cynco-audit.mjs verify --run m-w19', 'bun --no-install scripts/cynco-sandbox.mjs release m-w19'])
        const written = readFileSync(log, 'utf8').replace(/\r/g, '')
        if (line === null) expect(written).toBe('')
        else expect(written).toBe(`${line}\n`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('plan P6 items 1 and 2: the audit gate carries the run id; HEAD is read through harness git, never plain git', () => {
    const c = code()
    expect(c).toContain('AUDIT_LINE=$(bun --no-install scripts/cynco-audit.mjs check --run "$RUN_ID" | tr -d \'\\r\') ||')
    expect(c.indexOf('AUDIT_LINE=$(bun --no-install scripts/cynco-audit.mjs check --run "$RUN_ID"')).toBeGreaterThan(c.indexOf('RUN_ID=$(bun --no-install scripts/cynco-sandbox.mjs mint'))
    expect(c).not.toMatch(/git -C "\$MISSION_CWD" rev-parse/)
    // Changed on purpose in wave 19b (check A-R6): the one-liner asks isHarnessRefused, the one test.
    expect(c).toContain('MISSION_BASE=$(bun --no-install -e \'const { harnessGitBin, harnessGitEnv, isHarnessRefused } = await import("./engine/harnessGit.ts");')
    expect(c).toContain('const env = harnessGitEnv(process.env, { repo: d }); if (isHarnessRefused(env)) {')
    expect(c).toContain('  _mb=${MISSION_BASE:-no answer}\n  echo "[dispatch] REFUSED: the mission folder\'s HEAD could not be read through harness git: ${_mb//$\'\\n\'/; } — nothing was dispatched" >&2')
  })

  /**
   * Wave 19c (check CB-A-3): quoted text blanked in one left-to-right pass that tracks the quote state. A '...' string,
   * and a "..." string that holds no `$(` or backtick, is a message and becomes '' or ""; a "..." string that holds one
   * is code and is kept, read as one unit (the quotes nested in its substitution included), so its closing quote is
   * never paired with a later opening one, which blanked the code between them. A string not closed on its line is
   * left as code. A backslash outside quotes escapes the next character.
   */
  const blankQuoted = (text: string) => {
    const bq = (s: number) => { let j = s + 1; while (j < text.length && text[j] !== '`' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1; return j }
    // From just after `$(` to just after its `)`, or to the line's end.
    const sub = (s: number): number => {
      let j = s, depth = 1
      while (j < text.length && text[j] !== '\n') {
        const c = text[j]!
        if (c === '\\') j += 2
        else if (c === "'") { const k = text.indexOf("'", j + 1); const nl = text.indexOf('\n', j + 1); j = k < 0 || (nl >= 0 && nl < k) ? (nl < 0 ? text.length : nl) : k + 1 }
        else if (c === '"') { j = dq(j).end }
        else if (c === '`') { j = Math.min(bq(j) + 1, text.length) }
        else if (c === '(') { depth++; j++ }
        else if (c === ')') { if (--depth === 0) return j + 1; j++ }
        else j++
      }
      return j
    }
    // The "..." that opens at s: `end` just after its closing quote, `closed` whether it closed on its line, `code`.
    function dq(s: number): { end: number, closed: boolean, code: boolean } {
      let j = s + 1, code = false
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') j += 2
        else if (text[j] === '`') { code = true; j = Math.min(bq(j) + 1, text.length) }
        else if (text[j] === '$' && text[j + 1] === '(') { code = true; j = sub(j + 2) }
        else j++
      }
      const closed = text[j] === '"'
      return { end: closed ? j + 1 : j, closed, code }
    }
    let out = ''
    let i = 0
    while (i < text.length) {
      const c = text[i]!
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      if (c === "'") {
        const k = text.indexOf("'", i + 1)
        const nl = text.indexOf('\n', i + 1)
        if (k >= 0 && (nl < 0 || k < nl)) { out += "''"; i = k + 1; continue }
      }
      if (c === '"') {
        const q = dq(i)
        if (q.closed) { out += q.code ? text.slice(i, q.end) : '""'; i = q.end; continue }
      }
      out += c
      i++
    }
    return out
  }

  /** Wave 19b: every Bun start of a script text: `bun` at command position (a line's start, after ; & | { ( $( then do
   *  else, behind variable assignments), read outside quoted text, as `<start> :: <line>`. */
  const bunStarts = (text: string) => {
    const out: string[] = []
    for (const l of text.split('\n')) {
      if (l.trim().startsWith('#')) continue
      // Wave 19c (check CB-A-3): blanked by blankQuoted, one pass that tracks the quote state (was two replaces).
      const code = blankQuoted(l)
      for (const m of code.matchAll(/(?:^|[;&|{(]|\$\(|\bthen\b|\bdo\b|\belse\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:""|''|\S*)\s+)*bun\s+(\S+)/g)) out.push(`${m[1]} :: ${l.trim()}`)
    }
    return out
  }

  it('Bun never fetches a package by itself: every Bun start of the dispatch passes --no-install (wave 19b)', () => {
    const starts = bunStarts(sh())
    // 26 starts in wave 19b: the scan must keep finding them all, or a start it cannot read could lack the flag.
    expect(starts.length, starts.join('\n')).toBe(26)
    expect(starts.filter(s => !s.startsWith('--no-install :: ')), 'a Bun start without --no-install').toEqual([])
    // The scan sees a start without the flag in each shape the script uses, and not a word in a message.
    for (const bad of ['RUN_ID=$(bun scripts/a.mjs mint "$STAMP" | tr -d x)', '  bun engine/main.ts > "$LOG" 2>&1 &', 'lc() { bun scripts/a.mjs | tr -d x; }',
      'X="${X:-1}" bun engine/main.ts &', 'bun scripts/a.mjs post "$RUN_ID" || true', 'if true; then bun scripts/a.mjs; fi',
      // Wave 19c (check CB-A-3): a quoted command substitution, then a start and another quote on the same line.
      'X="$(date)"; bun scripts/new.mjs "y"', 'X="`date`"; bun scripts/new.mjs "y"'])
      expect(bunStarts(bad), bad).toHaveLength(1)
    expect(bunStarts('echo "[dispatch] run bun scripts/cynco-guard.mjs post $RUN_ID by hand"')).toEqual([])
  })

  it.skipIf(!existsSync(bash) || !onWindows)('plan P6 item 2, run for real: the HEAD read answers a repository\'s HEAD and refuses a .git that names another repository', (ctx) => {
    const bun = bunExe()
    if (bun === null) return ctx.skip('bun is not on the PATH (or did not name its executable)')
    const s = sh()
    const a = s.indexOf('MISSION_BASE=$(bun --no-install -e ')
    const b = s.indexOf('echo "[dispatch] mission baseline $MISSION_BASE"', a)
    const block = s.slice(a, b)
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w19-head-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
      expect(git(['init', '-q'], repo).status).toBe(0)
      writeFileSync(join(repo, 'a.txt'), 'a')
      git(['add', 'a.txt'], repo)
      expect(git(['commit', '-q', '-m', 'one'], repo).status).toBe(0)
      const sha = String(git(['rev-parse', 'HEAD'], repo).stdout).trim()
      const redirected = join(dir, 'redirected')
      mkdirSync(redirected)
      writeFileSync(join(redirected, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)
      const bunDir = dirname(bun).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
      const run = (cwdRepo: string) => runScript(`set -euo pipefail\nexport PATH="${bunDir}:$PATH"\ncd '${repoRoot.replace(/\\/g, '/')}'\nMISSION_CWD='${cwdRepo.replace(/\\/g, '/')}'\n${block}echo "BASE=$MISSION_BASE"\n`, { timeout: 60_000, env: { BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/' } })
      const ok = run(repo)
      expect(ok.status, ok.stderr).toBe(0)
      expect(String(ok.stdout).replace(/\r/g, '')).toContain(`BASE=${sha}\n`)
      const refused = run(redirected)
      expect(refused.status).toBe(1)
      expect(String(refused.stdout)).not.toContain('BASE=')
      expect(String(refused.stderr).replace(/\r/g, '')).toMatch(/^\[dispatch\] REFUSED: the mission folder's HEAD could not be read through harness git: \[harness-git\] git refused in [^\n]*; harness git refused the mission folder — nothing was dispatched\n$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it.skipIf(!existsSync(bash))('C2 and C3: no pid can ever be read: the dispatch refuses, ends its own child, settles not confirmed dead and does not go on', () => {
    const r = runConfirmation('bun.exe', '')
    expect(r.status, r.out).toBe(1)
    expect(r.out, 'the dispatch went on past the confirmation').not.toContain('AFTER-THE-CONFIRMATION')
    expect(r.out).toContain('winpid=\ntree=\nreads=3\n')
    expect(r.stderr).toMatch(/^\[dispatch\] REFUSED: the mission engine's pid was never confirmed as bun\.exe: 3 read\(s\) of \/proc\/\d+\/winpid, the last none \(\/proc\/\d+\/winpid could not be read\) — /m)
    expect(r.out).toContain('[dispatch] stopped before the mission started — no Windows pid of the mission engine was ever read\n')
    expect(r.out).toMatch(/\[dispatch\] stopped before the mission started — nothing was stopped by Windows pid, so the dispatch's own child \(shell pid \d+\) is ended with kill -9 /)
    expect(r.rec).toHaveLength(4)
    expect(r.rec[0]).toMatch(/^kill -9 \d+$/)
    expect(r.rec.slice(1)).toEqual([NOT_CONFIRMED_POST, RELEASE, PHONE_START])
  })

  it.skipIf(!existsSync(bash))('C3: tasklist failing on every read: the dispatch refuses, the trap can stop nothing by pid, so it ends its own child', () => {
    const r = runConfirmation('fails')
    expect(r.status, r.out).toBe(1)
    expect(r.out).not.toContain('AFTER-THE-CONFIRMATION')
    expect(r.stderr).toContain(', the last 4242 (tasklist could not be run or failed (exit 1)) — ')
    expect(r.out).toContain('[dispatch] stopped before the mission started — the mission engine\'s pid was never confirmed and pid 4242 is not its tree now (tasklist could not be run or failed (exit 1)); nothing was stopped by pid\n')
    expect(r.rec).toHaveLength(4)
    expect(r.rec[0]).toMatch(/^kill -9 \d+$/)
    expect(r.rec.slice(1)).toEqual([NOT_CONFIRMED_POST, RELEASE, PHONE_START])
  })

  it.skipIf(!existsSync(bash))('C3: the trap ends its own child only when nothing was stopped by Windows pid and the child is still running', () => {
    // The tree pid is held by another program now: nothing by pid, the child is ended.
    const other = runTrap('notepad.exe', { winpid: '', tree: '4242' })
    expect(other.status, other.stderr).toBe(0)
    expect(kills(other.rec)).toEqual(['kill -9 123'])
    expect(other.out).toContain('[dispatch] stopped before the mission started — nothing was stopped by Windows pid, so the dispatch\'s own child (shell pid 123) is ended with kill -9 (measured: that ends the bun.exe the npm shim started, at every moment of its start)\n')
    expect(posts(other.rec)).toEqual([NOT_CONFIRMED_POST])
    // No pid was ever read, and the child is no longer running: nothing is sent, and the line says so.
    const dead = runTrap('gone', { winpid: '', tree: '', dead: true })
    expect(dead.status, dead.stderr).toBe(0)
    expect(kills(dead.rec)).toEqual([])
    expect(dead.out).toContain('[dispatch] stopped before the mission started — nothing was stopped by Windows pid, and the dispatch\'s own child (shell pid 123) is not running\n')
    expect(posts(dead.rec)).toEqual([NOT_CONFIRMED_POST])
    // The tree stopped by its pid (the shim's sh.exe or a bun.exe): the child is not killed a second way. Changed on
    // purpose in wave 13d (R3): the pid is asked again after the taskkill, so "stopped" is a tree its taskkill ended;
    // one still there after it is the R3 case below.
    for (const answer of ['sh.exe-until-killed', 'bun.exe-until-killed'] as const) expect(kills(runTrap(answer, { winpid: '', tree: '4242' }).rec), answer).toEqual(['taskkill //PID 4242 //T //F'])
    // A confirmed engine that tasklist cannot be asked about: nothing killed by pid, so the child is ended too.
    const unread = runTrap('fails', { winpid: '4242', tree: '4242' })
    expect(kills(unread.rec)).toEqual(['kill -9 123'])
    expect(posts(unread.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned --engine-not-confirmed-dead pid 4242 asked for 10 s by the abandoned dispatch: tasklist could not be run or failed (exit 1)'])
  })

  it.skipIf(!existsSync(bash))('C4: the confirmed engine is killed only while tasklist lists it as bun.exe: listed (killed), reused by another image (not killed, gone), gone (not killed)', () => {
    const listed = runTrap('bun.exe-until-killed', { winpid: '4242', tree: '4242' })
    expect(listed.status, listed.stderr).toBe(0)
    expect(kills(listed.rec)).toEqual(['taskkill //PID 4242 //T //F'])
    expect(listed.out).toContain('[dispatch] stopped before the mission started — the mission engine this dispatch started is stopped\n')
    expect(posts(listed.rec)).toEqual([PLAIN_POST])
    const reused = runTrap('notepad.exe', { winpid: '4242', tree: '4242' })
    expect(kills(reused.rec)).toEqual([])
    expect(reused.out).toContain(`[dispatch] ${REUSED}\n`)
    expect(posts(reused.rec)).toEqual([PLAIN_POST])
    const gone = runTrap('gone', { winpid: '4242', tree: '4242' })
    expect(kills(gone.rec)).toEqual([])
    expect(gone.out).toContain('[dispatch] stopped before the mission started — the mission engine (bun.exe pid 4242) had already ended; nothing was killed\n')
    expect(posts(gone.rec)).toEqual([PLAIN_POST])
    // Still listed after the kill: killed once by pid, and settled as not confirmed dead. Changed on purpose in wave
    // 13d (R3): the dispatch's own child is then ended too (the R3 case below).
    const stays = runTrap('bun.exe', { winpid: '4242', tree: '4242' })
    expect(kills(stays.rec)).toEqual(['taskkill //PID 4242 //T //F', 'kill -9 123'])
    expect(posts(stays.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned --engine-not-confirmed-dead pid 4242 still listed 10 s after taskkill'])
    // The text: the confirmed pid is asked before the only taskkill of it, and that taskkill follows a `listed`.
    // Wave 13d (R2): counted with or without `.exe`, so a second taskkill spelled to miss the stub is counted too.
    const t = trapText()
    expect(t.indexOf('engine_listing_confirmed "$ENGINE_WINPID"')).toBeLessThan(t.indexOf('taskkill //PID "$ENGINE_WINPID"'))
    // Wave 19 (the w13 check's R2-case): an unquoted or braced pid is counted too.
    expect(t.match(/taskkill(?:\.exe)? +\/\/PID +"?\$\{?ENGINE_WINPID/gi)).toHaveLength(1)
    expect(t).toContain('if [ "$ENGINE_LISTING" = listed ] && [ -z "$_da_killed" ]; then\n        taskkill //PID "$ENGINE_WINPID" //T //F')
  })

  /** The driver's pid file block, from its `if` to the line after it, run under the stubs with tasklist by pid. */
  const driverPidBlock = () => {
    const s = sh()
    const a = s.indexOf('if [ -n "${DRIVER_PID_FILE:-}" ]; then\n')
    const b = s.indexOf('echo "[dispatch] dispatched', a)
    expect(a, 'the DRIVER_PID_FILE block is gone').toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    return s.slice(a, b)
  }
  /** `reads`: what each read of /proc/<pid>/winpid prints, in turn (the last one repeats); `images`: pid -> image ('' is no such task). */
  const runDriverPid = (reads: string[], images: Record<string, string>, { stale = false, file = true } = {}) => {
    const r = underStubs('gone', [
      `READS=(${reads.map(x => `'${x}'`).join(' ')})`,
      'seq() { command seq "$1" 3; }',
      // The read runs in a command substitution (a subshell), so the count of reads is kept in a file.
      'cat() { if [ "${1:-}" = "/proc/$DRIVER_PID/winpid" ]; then N=$(command cat "$REC_DIR/n" 2>/dev/null || echo 0); printf \'%s\\n\' $((N + 1)) > "$REC_DIR/n"; [ "$N" -lt "${#READS[@]}" ] || N=$((${#READS[@]} - 1)); printf \'%s\\n\' "${READS[$N]}"; else command cat "$@"; fi; }',
      `tasklist() { case "\${2#PID eq }" in ${Object.entries(images).map(([pid, im]) => im === '' ? `${pid}) echo 'INFO: No tasks are running which match the specified criteria.' ;;` : `${pid}) printf '"${im}","%s","Console","1","10 K"\\r\\n' "${pid}" ;;`).join(' ')} *) echo 'INFO: No tasks are running which match the specified criteria.' ;; esac; }`,
      'DRIVER_PID=$$',
      'DRIVER_LOG=/c/tmp/driver_x.log',
      file ? 'DRIVER_PID_FILE="$REC_DIR/driver.pid"' : 'unset DRIVER_PID_FILE',
      stale ? 'echo 999999 > "$DRIVER_PID_FILE"' : '',
      driverPidBlock(),
      'echo AFTER-THE-DRIVER-PID',
      'printf -- \'--pidfile--\\n\'; if [ -n "${DRIVER_PID_FILE:-}" ] && [ -f "$DRIVER_PID_FILE" ]; then command cat "$DRIVER_PID_FILE"; else echo ABSENT; fi',
      showRec,
    ].join('\n'))
    const at = r.out.indexOf('--pidfile--\n')
    return { ...r, file: at === -1 ? null : r.out.slice(at + 12).trim() }
  }

  it.skipIf(!existsSync(bash))('C5: the driver\'s pid is written only once tasklist shows it as bun.exe or the shim\'s sh.exe, never the forked bash\'s', () => {
    // Read 1 names Git Bash's forked bash (gone when asked), read 2 the shim's sh.exe.
    const sh2 = runDriverPid(['1111', '2222'], { 1111: '', 2222: 'sh.exe' }, { stale: true })
    expect(sh2.status, sh2.stderr).toBe(0)
    expect(sh2.file).toBe('2222')
    expect(sh2.out).toContain('[dispatch] driver pid 2222 (sh.exe; tasklist confirmed it at read 2) → ')
    expect(sh2.out).toContain('AFTER-THE-DRIVER-PID\n')
    const bunExe = runDriverPid(['3333'], { 3333: 'bun.exe' })
    expect(bunExe.file).toBe('3333')
    expect(bunExe.out).toContain('[dispatch] driver pid 3333 (bun.exe; tasklist confirmed it at read 1) → ')
    // A forked bash still alive at every read (bash.exe), or a pid that is gone: never written, and a file left by an
    // earlier dispatch of the same name is removed, so no reader takes its pid for this driver's.
    for (const [why, images] of [['bash.exe', { 1111: 'bash.exe' }], ['gone', { 1111: '' }]] as const) {
      const r = runDriverPid(['1111'], images, { stale: true })
      expect(r.status, `${why}: ${r.stderr}`).toBe(0)
      expect(r.file, why).toBe('ABSENT')
      expect(r.out, why).toContain('AFTER-THE-DRIVER-PID\n')
      expect(r.stderr, why).toMatch(/^\[dispatch\] driver pid NOT confirmed: 3 read\(s\) of \/proc\/\d+\/winpid, the last 1111 \(/m)
      expect(r.stderr, why).toContain(' — nothing was written to ')
      expect(r.stderr, why).toContain('a reader finds no pid file: the campaign runner and the gate author then fault the run with "dispatch or wait failed: ENOENT ..." and set the integrity latch as the mission engine not confirmed dead, unless the driver log already holds the driver\'s ledger line')
    }
    // No pid file asked for: nothing is read or written.
    const none = runDriverPid(['1111'], { 1111: 'sh.exe' }, { file: false })
    expect(none.status, none.stderr).toBe(0)
    expect(none.out).not.toContain('[dispatch] driver pid')
  })

  it('C5: the driver\'s pid is read like the engine\'s: no single read is written, and the block accepts only bun.exe or the shim\'s sh.exe', () => {
    const block = driverPidBlock()
    const c = code()
    expect(c).not.toMatch(/DRIVER_WINPID=\$\(cat /)
    expect(c).not.toContain('${DRIVER_WINPID:-$DRIVER_PID}')
    expect(block).toMatch(/\n {2}for _ in \$\(seq 1 40\); do\n {4}_dw=\$\(cat "\/proc\/\$DRIVER_PID\/winpid" 2>\/dev\/null \|\| true\)\n/)
    expect(block).toContain('        listed) DRIVER_WINPID=$_dw; DRIVER_IMAGE=bun.exe; break ;;\n        "unknown: pid $_dw is held by sh.exe, not bun.exe") DRIVER_WINPID=$_dw; DRIVER_IMAGE=sh.exe; break ;;\n')
    // The file is written in one place, after the loop, and only with a confirmed pid.
    expect(c.match(/> "\$DRIVER_PID_FILE"/g)).toEqual(['> "$DRIVER_PID_FILE"'])
    expect(block).toContain('  if [ -n "$DRIVER_WINPID" ]; then\n    echo "$DRIVER_WINPID" > "$DRIVER_PID_FILE"\n')
    expect(block.indexOf('rm -f -- "$DRIVER_PID_FILE"')).toBeLessThan(block.indexOf('for _ in $(seq 1 40); do'))
  })

  // ─── Wave 13d: what the third checks left (P1 above; R1 in the confirmation's text case; R2, R3, R5, R8) ──────
  /** Wave 13d (R5): the dispatch's check of its own image, from its SELF_WINPID= to the `fi` that ends the refusal. */
  const selfCheck = () => {
    const s = sh()
    const a = s.indexOf('\nSELF_WINPID=$(cat ')
    expect(a, 'the self check is gone').toBeGreaterThan(-1)
    return s.slice(a + 1, s.indexOf('\nfi\n', a) + 4)
  }
  const ONLY_BARE_NAMES = 'the outside programs are reached only by the bare names the stubs replace'
  /**
   * Wave 13d (R2): a lifted piece reaches taskkill, tasklist, kill, PowerShell and Bun only by the bare names the stubs
   * replace. Spelled `taskkill.exe`, by a path, or behind `command`, `builtin`, `exec`, `env` or `cmd //c`, a call
   * misses its recording stub: the record shows nothing, every runtime case passes, and under test the real program
   * runs (a real taskkill of the case's pid).
   */
  // Wave 19 (the w13 check's R2-case): also bare `pwsh` and `start`, and `timeout` among the names that must be stubbed
  // (tasklist and the start-time read run under it).
  const BYPASS = /\b(?:taskkill|tasklist|kill|powershell|pwsh|cmd|wmic|timeout)\.exe\b|(?:^|[\s;&|(`"'=])(?:\/[\w.-]+)+\/(?:taskkill|tasklist|kill|powershell|bun|cmd|timeout)\b|[\\/]System32[\\/]|\b(?:command|builtin|exec|env|nohup|xargs|cmd\s+\/\/?c)\s+(?:-\S+\s+)*(?:taskkill|tasklist|kill|powershell|bun|timeout)\b|\bStop-Process\b|\bwmic\b|(?:^|[\s;&|(`])pwsh\b|(?:^|[;&|(`]|\bthen|\bdo|\belse)\s*start\s/im
  /**
   * Wave 19b (check A-R3): the outside-program words at command position: a line's start, after ; & | ( ` $( !, then
   * do else if elif while until, or after `timeout N`. Read outside quoted text: a quoted string on one line that holds
   * no `$(` or backtick is a message and is blanked first (one that holds a command substitution is read as code).
   * Wave 19c (check CB-A-3): blanked by blankQuoted, one pass that tracks the quote state (was two replaces, which
   * paired the closing quote of a string holding `$(` with the next opening one and blanked the code between them).
   */
  const commandWords = (code: string) => blankQuoted(code)
    .matchAll(/(?:^|[;&|`(!]|\$\(|\bthen\b|\bdo\b|\belse\b|\bif\b|\belif\b|\bwhile\b|\buntil\b|\btimeout\s+\d+)\s*(taskkill|tasklist|kill|powershell|pwsh|bun|start|timeout)\b/gim)

  it('R2: every piece of the dispatch the cases lift and run under the stubs reaches its outside programs only by the bare stubbed names', () => {
    const pieces: Record<string, string> = {
      engine_listing: fnText(),
      engine_listing_confirmed: shFn('engine_listing_confirmed'),
      process_started: shFn('process_started'),
      dispatch_abandoned: trapText(),
      'the pid confirmation': confirmBlock(),
      'the driver pid block': driverPidBlock(),
      "the watcher's settle": watcherSettle(),
      'the self check': selfCheck(),
    }
    for (const [name, text] of Object.entries(pieces)) {
      expect(text, `${name} was not found`).not.toBe('')
      const code = text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
      expect(code, `${name}: ${ONLY_BARE_NAMES}`).not.toMatch(BYPASS)
      // Wave 19 (the w13 check's R2-case): a bash function name is case-sensitive while Git Bash finds a program on
      // NTFS whatever its case, so `TASKKILL` would miss the stub and run the real one. Every spelling is lower case.
      // Read at command position (a line's start, after ; & | ( ` $( then do else, or after `timeout N`); a word in a
      // message, such as "(PowerShell exit N)", is text.
      // Wave 19b (check A-R3): also after if, elif, while, until, `!` and a bare `(`, read outside quoted text (a
      // quoted string holding no `$(` or backtick is a message), so "(PowerShell exit N)" in an echo stays text.
      for (const m of commandWords(code)) expect(m[1], `${name}: ${m[0]}`).toBe(m[1]!.toLowerCase())
    }
    // The pattern itself catches the spellings the check named, and passes the script's own.
    for (const bad of ['taskkill.exe //PID "$ENGINE_WINPID" //T //F', '/bin/kill -f 123', 'command taskkill //PID 1', 'env kill -9 1', '/c/Windows/System32/taskkill //PID 1', 'cmd //c taskkill //PID 1', 'builtin kill -9 1', 'command -p taskkill //PID 1',
      "pwsh -c 'taskkill /PID 1'", 'start taskkill //PID 1', 'timeout.exe 20 tasklist', '/usr/bin/timeout 20 tasklist', 'command timeout 20 tasklist'])
      expect(bad).toMatch(BYPASS)
    // The case check sees a mutant spelled in capitals at command position.
    const caps = [...commandWords('  TASKKILL //PID $ENGINE_WINPID //T //F\n  x=$(Tasklist //FI "PID eq 1")')].map(m => m[1])
    expect(caps).toEqual(['TASKKILL', 'Tasklist'])
    // Wave 19b (check A-R3): and behind if, elif, while, until, `!` and a bare `(`, in quotes or not when it is code.
    const capsAfter = [...commandWords([
      'if TASKKILL //PID "$ENGINE_WINPID" //T //F; then :; fi',
      'if false; then :; elif Taskkill //PID 1; then :; fi',
      'while Tasklist //FI "PID eq 1" >/dev/null; do break; done',
      'until KILL -0 1; do break; done',
      '! TASKKILL //PID 1',
      '( Taskkill //PID 1 )',
      'x="$(TASKLIST //FI "PID eq 1")"',
      // Wave 19c (check CB-A-3): a quoted command substitution, then code and another quote on the same line: the
      // first string is read as one unit, so its closing quote is never paired with the next opening one.
      'x="$(a)"; TASKKILL //PID 1; y="z"',
      'x="`a`"; Tasklist //FI "PID eq 1"',
    ].join('\n'))].map(m => m[1])
    expect(capsAfter).toEqual(['TASKKILL', 'Taskkill', 'Tasklist', 'KILL', 'TASKKILL', 'Taskkill', 'TASKLIST', 'TASKKILL', 'Tasklist'])
    // A word in a message stays text: in an echo's quotes, or after a ( inside them.
    expect([...commandWords('echo "[dispatch] its start time could not be read (PowerShell exit 1)"\necho \'(Taskkill said no)\'')]).toEqual([])
    for (const good of ['taskkill //PID "$ENGINE_WINPID" //T //F >/dev/null 2>&1 || true', 'kill -9 "$ENGINE_PID" 2>/dev/null || true', 'echo "the mission engine (bun.exe pid 4242)"', 'bun --no-install scripts/cynco-guard.mjs post "$RUN_ID"',
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cynco-services.ps1 start engine', '_el_out=$(timeout 20 tasklist //FI "PID eq $1" //NH //FO CSV 2>/dev/null) || _el_rc=$?'])
      expect(good).not.toMatch(BYPASS)
  })

  it.skipIf(!existsSync(bash))('R3: a taskkill that did not end what it was aimed at is backed by the end of the dispatch\'s own child, and the line says why', () => {
    // The confirmed engine, still listed 10 s after its taskkill (access denied, a taskkill fault).
    const stays = runTrap('bun.exe', { winpid: '4242', tree: '4242' })
    expect(stays.status, stays.stderr).toBe(0)
    expect(kills(stays.rec)).toEqual(['taskkill //PID 4242 //T //F', 'kill -9 123'])
    expect(stays.out).toContain('[dispatch] stopped before the mission started — pid 4242 was still listed 10 s after its taskkill, so the dispatch\'s own child (shell pid 123) is ended with kill -9 (measured: that ends the bun.exe the npm shim started, at every moment of its start)\n')
    expect(posts(stays.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned --engine-not-confirmed-dead pid 4242 still listed 10 s after taskkill'])
    // The end of the child comes before the settle, the release and the phone engine.
    expect(stays.rec.indexOf('kill -9 123')).toBeLessThan(stays.rec.indexOf(posts(stays.rec)[0]))
    // The unconfirmed tree, still the shim's sh.exe or a bun.exe 10 s after its taskkill.
    for (const [answer, what] of [['sh.exe', 'the npm shim\'s sh.exe'], ['bun.exe', 'listed']] as const) {
      const r = runTrap(answer, { winpid: '', tree: '4242' })
      expect(r.status, `${answer}: ${r.stderr}`).toBe(0)
      expect(kills(r.rec), answer).toEqual(['taskkill //PID 4242 //T //F', 'kill -9 123'])
      expect(r.out, answer).toContain(`[dispatch] stopped before the mission started — pid 4242 was still ${what} 10 s after its taskkill, so the dispatch's own child (shell pid 123) is ended with kill -9 `)
      expect(posts(r.rec), answer).toEqual([NOT_CONFIRMED_POST])
    }
    // A taskkill that did end it: no second kill, no such line.
    for (const answer of ['sh.exe-until-killed', 'bun.exe-until-killed'] as const) {
      const r = runTrap(answer, { winpid: '', tree: '4242' })
      expect(kills(r.rec), answer).toEqual(['taskkill //PID 4242 //T //F'])
      expect(r.out, answer).not.toContain('10 s after its taskkill')
    }
    const ended = runTrap('bun.exe-until-killed', { winpid: '4242', tree: '4242' })
    expect(kills(ended.rec)).toEqual(['taskkill //PID 4242 //T //F'])
    // Not seen gone after the taskkill (tasklist failing from then on): ended the same way, with that reason.
    const unseen = runTrap('bun.exe-until-killed-then-fails', { winpid: '4242', tree: '4242' })
    expect(kills(unseen.rec)).toEqual(['taskkill //PID 4242 //T //F', 'kill -9 123'])
    expect(unseen.out).toContain('— pid 4242 was not seen gone 10 s after its taskkill (tasklist could not be run or failed (exit 1)), so the dispatch\'s own child (shell pid 123) is ended with kill -9 ')
    const unseenTree = runTrap('bun.exe-until-killed-then-fails', { winpid: '', tree: '4242' })
    expect(kills(unseenTree.rec)).toEqual(['taskkill //PID 4242 //T //F', 'kill -9 123'])
    expect(unseenTree.out).toContain('— pid 4242 was not seen gone after its taskkill (tasklist could not be run or failed (exit 1)), so the dispatch\'s own child (shell pid 123) is ended with kill -9 ')
    // The text: both branches set the reason from the answer AFTER their taskkill.
    const t = trapText()
    expect(t).toContain('    if [ -n "$_da_killed" ] && [ "$ENGINE_LISTING" != gone ]; then\n      if [ "$ENGINE_LISTING" = listed ]; then _da_end_child="pid $ENGINE_WINPID was still listed 10 s after its taskkill"\n')
    expect(t.indexOf('_da_end_child="pid $ENGINE_TREE_WINPID was still listed 10 s after its taskkill"')).toBeGreaterThan(t.indexOf('taskkill //PID "$ENGINE_TREE_WINPID"'))
    // Nine trap runs in Git Bash, several through their 5-round waits: about 3 s on this PC, more under load.
  }, 30_000)

  /** The self check run under the stubs, with what /proc/$$/winpid prints ('' for nothing). */
  const runSelfCheck = (answer: Answer, winpid = '4242') => underStubs(answer,
    `cat() { if [ "\${1:-}" = "/proc/$$/winpid" ]; then ${winpid === '' ? ':' : `echo ${winpid}`}; else command cat "$@"; fi; }\n${selfCheck()}echo AFTER-THE-SELF-CHECK\n${showRec}`)
  const SELF_REFUSED = (what: string) => new RegExp(`^\\[dispatch\\] REFUSED: this script runs only as bash\\.exe \\(bash scripts/dispatch-mission\\.sh, never sh scripts/dispatch-mission\\.sh\\): [^\\n]*; this shell \\(pid ${what}\\) answers: [^\\n]* — nothing was dispatched$`, 'm')

  it.skipIf(!existsSync(bash))('R5: the dispatch goes on only when its own shell is bash.exe; under sh.exe, or when its image cannot be read, it refuses before anything is started', () => {
    const ok = runSelfCheck('bash.exe')
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.out).toContain('AFTER-THE-SELF-CHECK\n')
    expect(ok.rec).toEqual([])
    // Changed on purpose in wave 19 (the w13 check's self-check-headline): the shell headline is printed only when an
    // image was read (sh.exe, bun.exe); when none could be (tasklist failing, the pid not listed, /proc unreadable) the
    // refusal says the shell's own image could not be read, so the owner does not look for a wrong shell.
    for (const answer of ['sh.exe', 'bun.exe', 'gone', 'fails'] as const) {
      const r = runSelfCheck(answer)
      expect(r.status, answer).toBe(1)
      expect(r.out, answer).not.toContain('AFTER-THE-SELF-CHECK')
      if (answer === 'sh.exe' || answer === 'bun.exe') expect(r.stderr, answer).toMatch(SELF_REFUSED('4242'))
      else expect(r.stderr, answer).toMatch(/^\[dispatch\] REFUSED: this shell's own image could not be read \([^\n]*\): every pid of the run would stay unconfirmed — nothing was dispatched$/m)
      expect(r.stderr, answer).toHaveLength(r.stderr.split('\n').filter(Boolean)[0]!.length + 1)
      expect(r.rec, answer).toEqual([])
    }
    expect(runSelfCheck('sh.exe').stderr).toContain('; this shell (pid 4242) answers: pid 4242 is held by sh.exe, not bun.exe — nothing was dispatched\n')
    expect(runSelfCheck('fails').stderr).toBe('[dispatch] REFUSED: this shell\'s own image could not be read (tasklist could not be run or failed (exit 1)): every pid of the run would stay unconfirmed — nothing was dispatched\n')
    const unread = runSelfCheck('bash.exe', '')
    expect(unread.status).toBe(1)
    expect(unread.stderr).toMatch(/^\[dispatch\] REFUSED: this shell's own image could not be read \(\/proc\/\d+\/winpid could not be read\): every pid of the run would stay unconfirmed — nothing was dispatched$/m)
    // Where it stands: after the listing functions it uses, before the trap, the baseline and the engine's start.
    const c = code()
    const at = c.indexOf('SELF_WINPID=$(cat ')
    expect(at).toBeGreaterThan(c.indexOf('engine_listing() {'))
    expect(at).toBeLessThan(c.indexOf('trap dispatch_abandoned EXIT'))
    expect(at).toBeLessThan(c.indexOf('bun --no-install scripts/cynco-guard.mjs pre '))
    expect(c).toContain('if [ "$ENGINE_LISTING" != "unknown: pid $SELF_WINPID is held by bash.exe, not bun.exe" ]; then\n')
  })

  it.skipIf(!onWindows || !existsSync(bash))('R5, run for real (Windows, Git Bash): the self check passes under bash and refuses under sh, whose forked children are sh.exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-w13d-self-'))
    try {
      const file = join(dir, 'self.sh')
      writeFileSync(file, `set -euo pipefail\n${fnText()}\n${selfCheck()}echo SELF-CHECK-PASSED\n`)
      const f = file.replace(/\\/g, '/')
      const r = runScript(`bash '${f}' 2>&1; echo "bash-exit=$?"\nsh '${f}' 2>&1; echo "sh-exit=$?"\n`, { dir, timeout: 60_000 })
      const out = String(r.stdout).replace(/\r/g, '')
      expect(out).toMatch(/^SELF-CHECK-PASSED\nbash-exit=0\n/)
      expect(out).toMatch(/\nsh-exit=1\n$/)
      expect(out).toMatch(/; this shell \(pid (\d+)\) answers: pid \1 is held by sh\.exe, not bun\.exe — nothing was dispatched\n/)
      expect(out).not.toMatch(/SELF-CHECK-PASSED\n[^\n]*\n[\s\S]*SELF-CHECK-PASSED/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!existsSync(bash))('R8: the confirmed engine is killed only while its creation time is the one read when it was confirmed', () => {
    // The same creation time: the engine, asked about before the kill (the start-time read precedes the taskkill).
    const same = runTrap('bun.exe-until-killed', { winpid: '4242', tree: '4242' })
    expect(kills(same.rec)).toEqual(['taskkill //PID 4242 //T //F'])
    expect(same.rec.indexOf('start-time 4242')).toBeGreaterThan(-1)
    expect(same.rec.indexOf('start-time 4242')).toBeLessThan(same.rec.indexOf('taskkill //PID 4242 //T //F'))
    expect(posts(same.rec)).toEqual([PLAIN_POST])
    // Another bun.exe on the pid: the engine ended and its pid was reused; nothing is killed, and that is said.
    const other = runTrap('bun.exe', { winpid: '4242', tree: '4242', now: '638000000000000777' })
    expect(kills(other.rec)).toEqual([])
    expect(other.out).toContain(`[dispatch] ${REUSED_BY_BUN}\n`)
    expect(other.out).toContain('[dispatch] stopped before the mission started — the mission engine (bun.exe pid 4242) had already ended; nothing was killed\n')
    expect(posts(other.rec)).toEqual([PLAIN_POST])
    // A creation time that cannot be read: not killed by its pid (it may be another bun.exe), the dispatch's own child
    // is ended instead, and the settle latches with the reason.
    const unread = runTrap('bun.exe', { winpid: '4242', tree: '4242', now: 'fail' })
    expect(kills(unread.rec)).toEqual(['kill -9 123'])
    expect(unread.out).toContain('[dispatch] stopped before the mission started — the mission engine (bun.exe pid 4242) was not killed by its pid: pid 4242 is a bun.exe, but its start time could not be read (PowerShell exit 1)\n')
    expect(posts(unread.rec)).toEqual(['bun --no-install scripts/cynco-guard.mjs post m-w13b --by dispatch-abandoned --engine-not-confirmed-dead pid 4242 asked for 10 s by the abandoned dispatch: pid 4242 is a bun.exe, but its start time could not be read (PowerShell exit 1)'])
    // A confirmed pid with no creation time recorded (no path sets one without the other): never killed by its pid.
    const none = runTrap('bun.exe', { winpid: '4242', tree: '4242', started: '' })
    expect(kills(none.rec)).toEqual(['kill -9 123'])
    expect(none.rec).not.toContain('start-time 4242')
    expect(none.out).toContain('was not killed by its pid: pid 4242 is a bun.exe, but no creation time of the engine was read when it was confirmed\n')
  })

  it.skipIf(!existsSync(bash))('R8: the confirmation takes a bun.exe only with its creation time; one whose creation time cannot be read is not confirmed, and the dispatch refuses', () => {
    const ok = runConfirmation('bun.exe')
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.rec).toContain('start-time 4242')
    // The refusal exits: the record is printed by an EXIT trap of the case's own.
    const failed = underStubs('bun.exe',
      'STARTED_NOW=fail\nseq() { command seq "$1" 3; }\n'
      + 'cat() { if [ "${1:-}" = "/proc/$ENGINE_PID/winpid" ]; then echo 4242; else command cat "$@"; fi; }\n'
      + 'show_rec() { printf -- \'--rec--\\n\'; command cat "$REC"; }\ntrap show_rec EXIT\n'
      + 'ENGINE_PID=$$\n' + confirmBlock() + 'echo AFTER-THE-CONFIRMATION\n')
    expect(failed.status).toBe(1)
    expect(failed.out).not.toContain('AFTER-THE-CONFIRMATION')
    expect(failed.rec.filter(l => l === 'start-time 4242')).toHaveLength(3)
    expect(failed.stderr).toContain(', the last 4242 (pid 4242 is a bun.exe, but its start time could not be read (PowerShell exit 1)) — ')
    // The watcher hands mission-end the creation time with the pid.
    expect(code()).toContain('bun --no-install scripts/cynco-mission-end.mjs --engine-pid "$ENGINE_WINPID" --engine-started "$ENGINE_STARTED" ${CYNCO_SKIP_IDLE_ENGINE:+--skip-idle}')
  })

  it.skipIf(!onWindows || !existsSync(bash))('R8, run for real (Windows, Git Bash): a live bun.exe\'s creation time reads the same each time; the confirmed pid with another recorded creation time reads as another bun.exe; ended, it is gone', async (ctx) => {
    const bun = bunExe()
    if (bun === null) return ctx.skip('bun is not on the PATH (or did not name its executable), so no bun.exe of the test\'s own could be started')
    const lifted = `set -euo pipefail\n${fnText()}\n${shFn('process_started')}${shFn('engine_listing_confirmed')}`
    const child = spawn(bun, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    try {
      const pid = child.pid!
      const live = runBash(`${lifted}process_started ${pid}\nA=$PROCESS_STARTED\nprocess_started ${pid}\nprintf 'a=%s\\nb=%s\\n' "$A" "$PROCESS_STARTED"\n`
        + `ENGINE_WINPID=${pid}\nENGINE_STARTED=$A\nengine_listing_confirmed ${pid}\nprintf 'same=%s|%s\\n' "$ENGINE_LISTING" "$ENGINE_REUSED_LINE"\n`
        + `ENGINE_STARTED=1\nengine_listing_confirmed ${pid}\nprintf 'other=%s|%s\\n' "$ENGINE_LISTING" "$ENGINE_REUSED_LINE"\n`)
      const got = Object.fromEntries(live.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      expect(got.a, live).toMatch(/^\d{15,}$/)
      expect(got.b).toBe(got.a)
      expect(got.same).toBe('listed|')
      expect(got.other).toBe(`gone|pid ${pid} is now another bun.exe (created ${got.a}; the engine was created 1): the engine's bun.exe has ended and its pid was reused`)
      child.kill()
      await exited
      const dead = runBash(`${lifted}ENGINE_WINPID=${pid}\nENGINE_STARTED=${got.a}\nfor _ in 1 2 3 4 5 6 7 8 9 10; do engine_listing_confirmed ${pid}; if [ "$ENGINE_LISTING" = gone ]; then break; fi; sleep 0.5; done\n`
        + `process_started ${pid}\nprintf '%s|%s|%s\\n' "$ENGINE_LISTING" "$PROCESS_STARTED" "$PROCESS_STARTED_WHY"\n`)
      expect(dead).toBe('gone||its start time could not be read (PowerShell exit 1)\n')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }, 120_000)
})

// ─── The mission driver after a latch (wave 13, rehearsal R2 against a stand-in engine) ─────────
describe('the mission driver after a latch (F242, wave 13 R2)', () => {
  const drv = () => read('scripts/cynco-mission-driver.mjs').replace(/\r\n/g, '\n')
  /**
   * One of the driver's self-contained decisions, lifted out of its text and run (the script cannot be
   * imported: it runs a mission when loaded). The text is the script's own, never a copy kept here.
   */
  const driverFn = <T,>(name: string): T => {
    const s = drv()
    const start = s.indexOf(`\nfunction ${name}(`)
    expect(start, `function ${name} is gone from the driver`).toBeGreaterThan(-1)
    const end = s.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    return new Function(`${s.slice(start + 1, end + 2)}\nreturn ${name}`)() as T
  }
  const INTEGRITY_STEP = 'Read the integrity latch (HALT.json in the guard folder) and its page before anything else is dispatched'
  const ENGINE_STEP = 'Check the engine log for the llama-server exit code'

  it('R2-1: the closing advice, by the layer that set the error (the table)', () => {
    const faultNextStep = driverFn<(layer: unknown) => string>('faultNextStep')
    expect(faultNextStep('integrity')).toBe(INTEGRITY_STEP)
    expect(faultNextStep('audit')).toMatch(/^Run `bun scripts\/cynco-audit\.mjs check`/)
    expect(faultNextStep('containment')).toMatch(/^Read the engine log's \[containment\] lines/)
    for (const other of [null, undefined, '', 'session', 'toString', 'constructor']) expect(faultNextStep(other), String(other)).toBe(ENGINE_STEP)
    const d = drv()
    expect(d).toContain('${faultNextStep(engineFaultLayer)} before re-dispatching')
    expect(d).not.toContain('FAULT_NEXT_STEP[')
  })

  it('R2-1: a latch that ends the run sets the layer to integrity, so the closing advice names the latch; an earlier error keeps its own', () => {
    const afterLatch = driverFn<(s: { engineError: string | null; engineFaultLayer: string | null }, latch: string) => { engineError: string | null; engineFaultLayer: string | null }>('afterLatch')
    const faultNextStep = driverFn<(layer: unknown) => string>('faultNextStep')
    const latched = afterLatch({ engineError: null, engineFaultLayer: null }, 'HALT.json stands (presence lost)')
    expect(latched).toEqual({ engineError: 'integrity: HALT.json stands (presence lost)', engineFaultLayer: 'integrity' })
    expect(faultNextStep(latched.engineFaultLayer)).toBe(INTEGRITY_STEP)
    expect(afterLatch({ engineError: 'llama-server exited 3', engineFaultLayer: null }, 'x')).toEqual({ engineError: 'llama-server exited 3', engineFaultLayer: null })
    expect(afterLatch({ engineError: 'audit: not written', engineFaultLayer: 'audit' }, 'x')).toEqual({ engineError: 'audit: not written', engineFaultLayer: 'audit' })
    // The wait loop's latch branch takes both from it.
    const d = drv()
    // Changed on purpose in wave 19 (plan P6 item 6): the branch is integrityStop's, with its reason sentence.
    const branch = d.slice(d.indexOf('if (stopNow) {'), d.indexOf('exitReason = stopNow.exitReason'))
    expect(branch).toContain('const latched = afterLatch({ engineError, engineFaultLayer }, stopNow.why)\n    engineError = latched.engineError\n    engineFaultLayer = latched.engineFaultLayer\n')
    expect(branch).not.toMatch(/engineError = `integrity/)
  })

  it('R2-2: the latch line says the engine is torn down only when CYNCO_TEARDOWN_ENGINE=1, the same test the teardown makes', () => {
    const latchLine = driverFn<(latch: string, teardown: boolean) => string>('latchLine')
    expect(latchLine('L', true)).toBe('[driver] INTEGRITY LATCH: L. The mission ends here: an open turn is aborted and the engine is torn down (CYNCO_TEARDOWN_ENGINE=1).')
    expect(latchLine('L', false)).toBe('[driver] INTEGRITY LATCH: L. The mission ends here: an open turn is aborted and the engine is left running (CYNCO_TEARDOWN_ENGINE is not 1: this driver does not own the engine).')
    const d = drv()
    // Changed on purpose in wave 19 (plan P6 item 6): the line is built by integrityStop with the same test.
    expect(d).toContain("const stopNow = integrityStop(haltState(runContainment().folders.guard), process.env.CYNCO_TEARDOWN_ENGINE === '1')")
    expect(d).toContain('    console.log(stopNow.line)\n')
    expect(d).toContain("if (process.env.CYNCO_TEARDOWN_ENGINE === '1' && wsClosed) {")
    expect(d).toContain("} else if (process.env.CYNCO_TEARDOWN_ENGINE === '1') {")
  })

  it('R2-3: a completion that closed an aborted turn is not judged as an answer (the table, and the shape the engine sends)', () => {
    const isAbortedCompletion = driverFn<(m: unknown, abortSent: boolean) => boolean>('isAbortedCompletion')
    expect(isAbortedCompletion({ type: 'message.complete', messageId: '', stopReason: 'aborted' }, false)).toBe(true)
    expect(isAbortedCompletion({ type: 'message.complete', messageId: 'm1', stopReason: 'end_turn' }, true)).toBe(true)
    expect(isAbortedCompletion({ type: 'message.complete', messageId: 'm1', stopReason: 'end_turn' }, false)).toBe(false)
    expect(isAbortedCompletion({ type: 'message.complete', messageId: 'm1' }, false)).toBe(false)
    expect(isAbortedCompletion({ type: 'tool.start', toolName: 'Bash' }, true)).toBe(false)
    expect(isAbortedCompletion(null, true)).toBe(false)
    // What the engine sends after an abort: the shape relied on.
    expect(read('engine/bridge/conversationLoop.ts')).toContain("this.emit({ type: 'message.complete', messageId: '', stopReason: 'aborted' })")
    const d = drv()
    const handler = d.slice(d.indexOf('function onMissionMessage(ev) {'), d.indexOf('const onMissionError ='))
    expect(handler).toContain('const aborted = isAbortedCompletion(m, abortSent)')
    // Not handed to the collector's ingest, whose message.complete case is the refusal count's judging. Changed on
    // purpose in wave 13b (B1-1): the collector is told the turn ended on an abort, so what that turn streamed is
    // dropped unjudged instead of staying pending and being read as the opening of the next answer.
    expect(handler).toMatch(/if \(aborted\) \{\n {6}console\.log\([^\n]*\)\n {6}collector\.endAbortedTurn\(\)\n {4}\} else collector\.ingest\(m\)\n/)
    expect(d.match(/collector\.ingest\(/g)?.length, 'the collector is fed in one place only').toBe(1)
    expect(d.match(/collector\.endAbortedTurn\(/g)?.length).toBe(1)
    expect(read('scripts/cynco-ledger.mjs').replace(/\r\n/g, '\n')).toContain("case 'message.complete': {\n          // The turn's answer")
    // Not an F7 zero-tool completion.
    expect(handler).toContain("if (m.type === 'message.complete' && toolCount === 0 && !aborted) {")
    // The driver marks its own abort before it sends it.
    expect(d).toContain("abortSent = true\n    try { ws.send(JSON.stringify({ type: 'abort' }))")
    expect(d.indexOf('let abortSent = false')).toBeLessThan(d.indexOf('function onMissionMessage(ev) {'))
  })

  it('B1-1: the completion that answers the driver\'s own abort ends the turn but is not a turn the engine closed after a marker-check note (noteAcknowledged)', async () => {
    const d = drv()
    const handler = d.slice(d.indexOf('function onMissionMessage(ev) {'), d.indexOf('const onMissionError ='))
    const line = handler.split('\n').find(l => l.trim().startsWith("if (m.type === 'message.complete') {")) ?? ''
    expect(line.trim()).toBe("if (m.type === 'message.complete') { sawMessageComplete = true; lastActivityAt = Date.now(); if (!aborted) messageCompletes++ }")
    expect(d.match(/\bmessageCompletes\+\+/g)?.length, 'messageCompletes is counted in one place only').toBe(1)
    // The driver's own line, run: the turn-end flags see every completion, the count only one the engine closed.
    type S = { sawMessageComplete: boolean; lastActivityAt: number; messageCompletes: number }
    const step = new Function('m', 'aborted', 's', `let { sawMessageComplete, lastActivityAt, messageCompletes } = s\n${line}\nreturn { sawMessageComplete, lastActivityAt, messageCompletes }`) as (m: unknown, aborted: boolean, s: S) => S
    const isAbortedCompletion = driverFn<(m: unknown, abortSent: boolean) => boolean>('isAbortedCompletion')
    const { noteAcknowledged } = await import('../../../scripts/cynco-marker-check.mjs')
    const atNote: S = { sawMessageComplete: false, lastActivityAt: 0, messageCompletes: 7 }
    // The note's turn never closed by itself; the driver's abort closed it.
    const answerToAbort = { type: 'message.complete', messageId: '', stopReason: 'aborted' }
    const afterAbort = step(answerToAbort, isAbortedCompletion(answerToAbort, true), atNote)
    expect(afterAbort).toMatchObject({ sawMessageComplete: true, messageCompletes: 7 })
    expect(noteAcknowledged({ retried: true, completesAtNote: 7, completesAtVerify: afterAbort.messageCompletes })).toBe(false)
    // A turn the engine closed after the note is the acknowledgement.
    const closed = { type: 'message.complete', messageId: 'm9', stopReason: 'end_turn' }
    const afterClose = step(closed, isAbortedCompletion(closed, false), atNote)
    expect(afterClose).toMatchObject({ sawMessageComplete: true, messageCompletes: 8 })
    expect(noteAcknowledged({ retried: true, completesAtNote: 7, completesAtVerify: afterClose.messageCompletes })).toBe(true)
  })

  it('C6 (wave 13c): the line after an unanswered marker-check note says what was measured, not that the engine never acted', () => {
    const d = drv()
    // noteAcknowledged counts turns the engine closed after the note; a turn the driver's own abort closed is not
    // counted (B1-1), so an engine still working on the note when the wait ended reads false too.
    expect(d).toContain("    if (acknowledged === false) console.log('[verify] the note was delivered, and no turn closed by the engine after it; a turn the driver aborted is not counted (verify.noteAcknowledged: false)')\n")
    expect(d).not.toContain('the engine never acted on it')
    expect(d.match(/acknowledged === false/g)).toHaveLength(1)
  })

  // Changed on purpose in wave 19 (plan P6 item 6): the poll reads the guard's state, so a guard folder that cannot be
  // used prints its own words and exit reason (integrityStop), never the latch line.
  it('B1-10: the latch branch of the wait loop, exactly: no line can slip in', () => {
    const d = drv()
    const at = d.indexOf("  const stopNow = integrityStop(haltState(runContainment().folders.guard), process.env.CYNCO_TEARDOWN_ENGINE === '1')\n")
    expect(at).toBeGreaterThan(-1)
    const end = d.indexOf('\n  }\n', at)
    expect(d.slice(at, end + 5)).toBe([
      "  const stopNow = integrityStop(haltState(runContainment().folders.guard), process.env.CYNCO_TEARDOWN_ENGINE === '1')",
      '  if (stopNow) {',
      '    console.log(stopNow.line)',
      '    const latched = afterLatch({ engineError, engineFaultLayer }, stopNow.why)',
      '    engineError = latched.engineError',
      '    engineFaultLayer = latched.engineFaultLayer',
      '    exitReason = stopNow.exitReason',
      '    break',
      '  }',
      '',
    ].join('\n'))
    expect(d.match(/integrityStop\(haltState\(runContainment\(\)\.folders\.guard\)/g)?.length, 'the wait loop polls the latch in one place').toBe(1)
    expect(d).not.toMatch(/haltRefusal\(runContainment\(\)\.folders\.guard\)/)
  })

  // ─── Wave 19: plan P6 items 5 and 6 and decision sheet item 25 in the driver ──────────────────────────────
  /** Several of the driver's functions lifted together (integrityStop calls latchLine). */
  const driverFns = <T,>(names: string[], ret: string): T => {
    const s = drv()
    const parts = names.map(name => {
      const start = s.indexOf(`\nfunction ${name}(`)
      expect(start, `function ${name} is gone from the driver`).toBeGreaterThan(-1)
      return s.slice(start + 1, s.indexOf('\n}\n', start) + 2)
    })
    return new Function(`${parts.join('\n')}\nreturn ${ret}`)() as T
  }

  it('P6 item 6: a latch and an unusable guard end the mission each in its own words and exit reason; either exits 1, landed or not', () => {
    const integrityStop = driverFns<(s: unknown, t: boolean) => { exitReason: string; why: string; line: string } | null>(['latchLine', 'integrityStop'], 'integrityStop')
    expect(integrityStop(null, false)).toBeNull()
    expect(integrityStop({ state: 'clear' }, true)).toBeNull()
    const latched = integrityStop({ state: 'latched', summary: 'HALT.json set by x' }, true)!
    expect(latched.exitReason).toBe('integrity-latch')
    expect(latched.line).toBe('[driver] INTEGRITY LATCH: HALT.json set by x. The mission ends here: an open turn is aborted and the engine is torn down (CYNCO_TEARDOWN_ENGINE=1).')
    const unusable = integrityStop({ state: 'unusable', summary: 'the guard folder C:/g does not exist' }, false)!
    expect(unusable.exitReason).toBe('integrity-guard-unusable')
    expect(unusable.line).toBe('[driver] INTEGRITY GUARD UNUSABLE: the guard folder C:/g does not exist. The mission ends here: an open turn is aborted and the engine is left running (CYNCO_TEARDOWN_ENGINE is not 1: this driver does not own the engine).')
    expect(unusable.line).not.toContain('INTEGRITY LATCH')
    const exitCodeOf = driverFn<(landed: boolean, why: string | null) => number>('exitCodeOf')
    expect(exitCodeOf(true, 'engine_closed_the_turn')).toBe(0)
    expect(exitCodeOf(true, 'integrity-latch')).toBe(1)
    expect(exitCodeOf(true, 'integrity-guard-unusable')).toBe(1)
    expect(exitCodeOf(false, null)).toBe(1)
    const d = drv()
    expect(d).toContain('process.exit(exitCodeOf(landed, exitReason))')
    expect(d).not.toContain('process.exit(landed ? 0 : 1)')
    expect(d).toContain("integrityStop: exitReason === 'integrity-latch' || exitReason === 'integrity-guard-unusable' })")
    // The in-loop marker check and the final verify end the mission on a check the latch cut (runAuthorCheck's `integrity`).
    expect(d).toContain("const cut = integrityStop(attempt.r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')")
    expect(d).toContain("const cutAtVerify = integrityStop(r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')")
  })

  it('P6 item 5 (R2-6): the teardown fallback ends only the mission engine\'s own tree, by the pid and creation time the dispatch confirmed', () => {
    const target = driverFn<(env: Record<string, string | undefined>) => { pid?: string; started?: string; why?: string }>('engineTeardownTarget')
    expect(target({ CYNCO_ENGINE_WINPID: '4242', CYNCO_ENGINE_STARTED: '638000000000000001' })).toEqual({ pid: '4242', started: '638000000000000001' })
    for (const env of [{}, { CYNCO_ENGINE_WINPID: '' }, { CYNCO_ENGINE_WINPID: '0' }, { CYNCO_ENGINE_WINPID: '42 42' }, { CYNCO_ENGINE_WINPID: '4242; x' }])
      expect(target({ ...env, CYNCO_ENGINE_STARTED: '1' }).why, JSON.stringify(env)).toMatch(/^no confirmed Windows pid of the mission engine/)
    expect(target({ CYNCO_ENGINE_WINPID: '4242' }).why).toMatch(/came with no creation time/)
    const d = drv()
    const fn = d.slice(d.indexOf('\nfunction killEngineTree('), d.indexOf('\n}\n', d.indexOf('\nfunction killEngineTree(')))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(fn).toContain('const roots = [target.pid]')
    expect(fn).not.toMatch(/engine\/main\.ts|chatModelServerPids|llama/)
    // The start time is compared before anything is killed.
    expect(fn.indexOf('if (startedNow !== target.started)')).toBeLessThan(fn.indexOf("spawnSync('taskkill'"))
    expect(fn).toContain("spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf-8', timeout: 20_000 })")
  })

  it('item 25: the mark is read and deleted before anything starts; a refusal under it comes before the audit probe and the purges', () => {
    const d = drv()
    const del = d.indexOf('\ndelete process.env[AUTHOR_CHECK_MARK]\n')
    expect(del).toBeGreaterThan(-1)
    expect(d.indexOf('\nconst authorMark = process.env[AUTHOR_CHECK_MARK]\n')).toBeLessThan(del)
    const body = d.slice(d.lastIndexOf('\nimport '))
    const firstRun = Math.min(...['spawnSync(', 'Bun.spawn(', 'adoptContainment(', 'toolAudit()', 'new WebSocket('].map(n => { const i = d.indexOf(n, d.indexOf(body)); return i === -1 ? Infinity : i }))
    expect(del).toBeLessThan(firstRun)
    const plan = d.indexOf("const AUTHOR = authorCheckPlan({ mark: authorMark, checkCmd, markerCheck: process.env.CYNCO_MARKER_CHECK, probeCmd, cwd: CWD })")
    expect(plan).toBeGreaterThan(-1)
    expect(d.slice(plan)).toMatch(/^const AUTHOR = [^\n]*\nif \(AUTHOR\.kind === 'refused'\) \{\n {2}console\.error\(`\[driver\] REFUSED: \$\{AUTHOR\.why\} — nothing was dispatched`\)\n {2}process\.exit\(2\)\n\}/)
    expect(plan).toBeLessThan(d.indexOf("audit.probe('driver')"))
    expect(plan).toBeLessThan(d.indexOf('purgeBytecodeCaches(CWD)'))
    expect(d.match(/authorMark/g)).toHaveLength(2)
  })

  it('item 25: the check runs outside the box only under the mark; every other check runs in the box as before', () => {
    const d = drv()
    const g = d.slice(d.indexOf('async function gradeAtCheck('), d.indexOf('\n}\n', d.indexOf('async function gradeAtCheck(')))
    // Changed on purpose in wave 19b (plan P6 item 6, the in-box half): the in-box check runs through inBoxCheck, which
    // asks the latch while it runs and hands runCheckAsync its signal (the case above runs it).
    expect(g).toContain([
      '  const r = resetRefused ? notRunResult(resetRefused)',
      "    : AUTHOR.kind === 'run'",
      '      ? await runAuthorCheck({ stagingDir: AUTHOR.stagingDir, baseDir: AUTHOR.baseDir, timeoutMs: MARKER.timeoutMs, ordinal,',
      "          latch: () => haltState(runContainment().folders.guard), audit: { handle: audit, src: 'driver-marker' } })",
      '      : await inBoxCheck(ordinal)',
    ].join('\n'))
    expect(d.match(/runAuthorCheck\(/g)).toHaveLength(1)
    expect(d.match(/runCheckAsync\(/g)).toHaveLength(1)
    expect(d).toContain("await runCheckAsync(MARKER.command, CWD, MARKER.timeoutMs, { env: { CYNCO_CHECK_ORDINAL: String(ordinal) }, contained: runContainment(), audit: { handle: audit, src: 'driver-marker' }, signal: poll.signal })")
    // The probe is never run outside the box (authorCheckPlan refuses a probe under the mark).
    expect(d).toContain("runCheck(probeCmd, CWD, PROBE_TIMEOUT_MS, { contained: runContainment(), audit: { handle: audit, src: 'driver-probe' } })")
    const notRunResult = driverFn<(why: string) => Record<string, unknown>>('notRunResult')
    expect(notRunResult('x')).toMatchObject({ verified: null, exitCode: null, harnessFault: 'x', spawnFailed: true })
  })

  it('A3: the F132 reset writes the work tree under harness git with worktreeLinks, and a refused reset runs no check', () => {
    const d = drv()
    const g = d.slice(d.indexOf('async function gradeAtCheck('), d.indexOf('\n}\n', d.indexOf('async function gradeAtCheck(')))
    expect(g).toContain('const resetEnv = harnessGitEnv(process.env, { repo: CWD, worktreeLinks: true })')
    // Changed on purpose in wave 19b (check A-R6): the one test isHarnessRefused, and the reset runs with the
    // environment it judged (no second walk, so a reset is never claimed when the second call refused).
    expect(g).toContain('if (isHarnessRefused(resetEnv)) {')
    expect(g).toContain("spawnSync(GIT, ['checkout', '--', '.'], { cwd: CWD, env: resetEnv })")
    expect(g.indexOf('if (isHarnessRefused(resetEnv)) {')).toBeGreaterThan(-1)
    expect(g.indexOf('if (isHarnessRefused(resetEnv)) {')).toBeLessThan(g.indexOf("spawnSync(GIT, ['checkout', '--', '.']"))
    expect(d.match(/'checkout', '--', '\.'/g)).toHaveLength(1)
  })

  it('R2-8: after the adopt, one line with the run id, the isolation in the engine boot line\'s words and the probe\'s milliseconds', () => {
    const adoptLine = driverFn<(a: unknown) => string>('adoptLine')
    expect(adoptLine({ ok: true, containment: { runId: 'm-20261125T010203-ab12', isolation: 'verified' }, probeMs: 412 })).toBe('[driver] adopted run m-20261125T010203-ab12: verified, probe 412 ms')
    expect(adoptLine({ ok: true, containment: { runId: 'm-1', isolation: 'overlay' }, probeMs: 0 })).toBe('[driver] adopted run m-1: overlay only, probe 0 ms')
    // The engine's own boot line uses the same two words.
    expect(read('engine/main.ts')).toContain("k.isolation === 'verified' ? 'verified' : 'overlay only'")
    const d = drv()
    const set = d.indexOf('setRunContainment(adopted.containment)\n')
    expect(set).toBeGreaterThan(-1)
    const next = d.slice(set, d.indexOf('const GIT = harnessGitBin()'))
    expect(next).toContain('\nconsole.log(adoptLine(adopted))\n')
  })

  // ─── Wave 19b: what check A found in the driver (A-F1, A-R1, A-R2, A-R6, A-R7) and Bun's --no-install ─────────
  it('A-R1: the two cuts after a check the latch ended, exactly: the in-loop marker check and the final verify', () => {
    const d = drv()
    const cutAt = d.indexOf("      const cut = integrityStop(attempt.r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')\n")
    expect(cutAt, 'the in-loop cut is gone').toBeGreaterThan(-1)
    expect(d.slice(cutAt, d.indexOf('\n      }\n', cutAt) + 9)).toBe([
      "      const cut = integrityStop(attempt.r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')",
      '      if (cut) {',
      '        console.log(cut.line)',
      '        const latched = afterLatch({ engineError, engineFaultLayer }, cut.why)',
      '        engineError = latched.engineError',
      '        engineFaultLayer = latched.engineFaultLayer',
      '        exitReason = cut.exitReason',
      '        markerVerdict = attempt',
      '        break',
      '      }',
      '',
    ].join('\n'))
    const verifyAt = d.indexOf("    const cutAtVerify = integrityStop(r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')\n")
    expect(verifyAt, 'the cut at the final verify is gone').toBeGreaterThan(-1)
    expect(d.slice(verifyAt, d.indexOf('\n    }\n', verifyAt) + 7)).toBe([
      "    const cutAtVerify = integrityStop(r.integrity ?? null, process.env.CYNCO_TEARDOWN_ENGINE === '1')",
      '    if (cutAtVerify && exitReason !== cutAtVerify.exitReason) {',
      '      console.log(cutAtVerify.line)',
      '      const latched = afterLatch({ engineError, engineFaultLayer }, cutAtVerify.why)',
      '      engineError = latched.engineError',
      '      engineFaultLayer = latched.engineFaultLayer',
      '      exitReason = cutAtVerify.exitReason',
      '    }',
      '',
    ].join('\n'))
    expect(d.match(/integrityStop\(attempt\.r\.integrity/g)).toHaveLength(1)
    expect(d.match(/integrityStop\(r\.integrity/g)).toHaveLength(1)
  })

  it('A-R2: the teardown kills only when the pid\'s creation time read now is the confirmed one (the decision, run)', () => {
    const decide = driverFn<(t: { pid: string; started: string }, now: string) => { kill: boolean; why?: string }>('teardownDecision')
    const t = { pid: '4242', started: '638000000000000001' }
    expect(decide(t, '638000000000000001')).toEqual({ kill: true })
    for (const now of ['', '638000000000000002', ' 638000000000000001', '638000000000000001 ']) {
      const r = decide(t, now)
      expect(r.kill, JSON.stringify(now)).toBe(false)
      expect(r.why).toMatch(/^pid 4242 is not the mission engine now \(/)
      expect(r.why).toContain('the engine was created 638000000000000001')
    }
    expect(decide(t, '').why).toContain('not running, or its start time could not be read')
    const d = drv()
    const fn = d.slice(d.indexOf('\nfunction killEngineTree('), d.indexOf('\n}\n', d.indexOf('\nfunction killEngineTree(')))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const decided = fn.indexOf('const decided = teardownDecision(target, startedNow)')
    expect(decided).toBeGreaterThan(-1)
    expect(fn).toContain("  if (!decided.kill) {\n    console.log(`[driver] F131 escalation (${reason}): ${decided.why} — nothing was killed`)\n    return\n  }\n")
    expect(decided).toBeLessThan(fn.indexOf("spawnSync('taskkill'"))
    expect(fn).not.toContain('startedNow !==')
  })

  it('A-R6: the F132 reset asks isHarnessRefused once and runs git with that same environment; no package-A site compares GIT_DIR itself', () => {
    const d = drv()
    const g = d.slice(d.indexOf('async function gradeAtCheck('), d.indexOf('\n}\n', d.indexOf('async function gradeAtCheck(')))
    expect(g).toContain('          if (isHarnessRefused(resetEnv)) {\n')
    expect(g).toContain("            spawnSync(GIT, ['checkout', '--', '.'], { cwd: CWD, env: resetEnv })\n")
    expect(g.match(/harnessGitEnv\(process\.env, \{ repo: CWD, worktreeLinks: true \}\)/g)).toHaveLength(1)
    for (const f of ['scripts/cynco-mission-driver.mjs', 'scripts/cynco-gate-author.mjs', 'scripts/dispatch-mission.sh']) {
      const text = read(f)
      expect(text, f).not.toMatch(/GIT_DIR === refusedGitDir\(\)/)
      expect(text, f).toMatch(/isHarnessRefused\((?:resetEnv|env)\)/)
    }
  })

  it('A-R7: the comment over the teardown says what it kills now', () => {
    const d = drv()
    const at = d.indexOf('\nfunction killEngineTree(')
    const comment = d.slice(d.lastIndexOf('\n\n', at), at)
    expect(comment).not.toContain('same match rules as dispatch-mission.sh')
    expect(comment).not.toContain('cynco-llama-sweep.mjs')
    expect(comment).toContain('the pid and creation time the dispatch confirmed')
  })

  it('A-F1: a check whose only problem is the frozen suite baseline is said as owed to the runner, at the marker check and at the final verify', () => {
    const d = drv()
    expect(d).toContain("      if (attempt.r.baselineOwed) console.log(`[verify] marker check: ${attempt.r.harnessFault} — no note is sent`)\n")
    expect(d).toContain('    if (r.baselineOwed) console.log(`[verify] verified stays null, ${r.harnessFault}`)\n')
    // Neither the harness-fault line nor the advice to raise the cap is printed for it.
    expect(d).toContain('    else if (r.harnessFault) {\n      console.log(`[verify] HARNESS FAULT — verified stays null: ${r.harnessFault}`)\n')
    expect(d).toContain('    if (gate.label && r.verified === null && !r.baselineOwed) {\n')
  })

  it('plan P6 item 6, the in-box half: a latch, or a guard that became unusable, ends the in-box marker check while it runs (the function, run with stand-ins)', async () => {
    const d = drv()
    const at = d.indexOf('\nasync function inBoxCheck(')
    expect(at, 'inBoxCheck is gone from the driver').toBeGreaterThan(-1)
    const text = d.slice(at + 1, d.indexOf('\n}\n', at) + 2)
    const author = await import('../../../scripts/cynco-gate-author.mjs')
    const notRunResult = driverFn<(why: string) => Record<string, unknown>>('notRunResult')
    const CTX = { runId: 'm-w19b', folders: { guard: 'G' } }
    type R = Record<string, unknown>
    const lift = (runCheckAsync: (...a: unknown[]) => Promise<R>, haltState: (g: string) => unknown) => new Function(
      'runCheckAsync', 'MARKER', 'CWD', 'audit', 'runContainment', 'haltState', 'latchPoll', 'latchCutWords', 'guardWords', 'notRunResult', `${text}\nreturn inBoxCheck`,
    )(runCheckAsync, { command: 'pytest -q', timeoutMs: 60_000 }, 'C:/m', 'AUDIT', () => CTX, haltState, author.latchPoll, author.latchCutWords, author.guardWords, notRunResult) as (ordinal: number, pollMs?: number) => Promise<R>
    const LATCHED = { state: 'latched', summary: 'HALT.json set by x' }

    // A latch set while it runs: the signal aborts, the check reports itself stopped, and the result carries the latch.
    const calls: unknown[][] = []
    let asks = 0
    const stopped = lift((...a) => { calls.push(a); const sig = (a[3] as { signal: AbortSignal }).signal; return new Promise(res => sig.addEventListener('abort', () => res({ verified: null, stopped: true, harnessFault: 'stopped by its caller', output: 'x' }), { once: true })) },
      () => (++asks > 1 ? LATCHED : { state: 'clear' }))
    const r = await stopped(3, 10)
    expect(calls).toHaveLength(1)
    const [cmd, cwd, cap, opts] = calls[0] as [string, string, number, Record<string, unknown>]
    expect([cmd, cwd, cap]).toEqual(['pytest -q', 'C:/m', 60_000])
    expect(opts.env).toEqual({ CYNCO_CHECK_ORDINAL: '3' })
    expect(opts.contained).toBe(CTX)
    expect(opts.audit).toEqual({ handle: 'AUDIT', src: 'driver-marker' })
    expect((opts.signal as AbortSignal).aborted).toBe(true)
    expect(r).toMatchObject({ verified: null, stopped: true, integrity: LATCHED, harnessFault: author.latchCutWords(LATCHED as never) })

    // A latch before the start: nothing is started.
    const none: unknown[] = []
    const before = await lift(async (...a) => { none.push(a); return {} }, () => LATCHED)(1, 10)
    expect(none).toEqual([])
    expect(before).toMatchObject({ verified: null, integrity: LATCHED })
    expect(String(before.harnessFault)).toMatch(/^the integrity latch was set \(HALT\.json set by x\) before the check started; nothing was run$/)

    // A guard that stays clear: the check's own result, untouched.
    const own = { verified: true, exitCode: 0, harnessFault: null, stopped: false }
    expect(await lift(async () => own, () => ({ state: 'clear' }))(2, 10)).toBe(own)

    // Wave 19c (check CB-A-2): the poll saw the latch in the same window in which the check ended by itself (not
    // stopped). The result still carries the latch, so the final verify's cut ends the mission on it (no later poll
    // comes after the final verify); the check's own reading is kept, since it ran to its end.
    let asks2 = 0
    const endedItself = { verified: true, exitCode: 0, harnessFault: null, stopped: false }
    const unstopped = await lift((...a) => { const sig = (a[3] as { signal: AbortSignal }).signal; return new Promise(res => sig.addEventListener('abort', () => res(endedItself), { once: true })) },
      () => (++asks2 > 1 ? LATCHED : { state: 'clear' }))(4, 10)
    expect(unstopped).toMatchObject({ verified: true, exitCode: 0, harnessFault: null, stopped: false, integrity: LATCHED })

    // gradeAtCheck runs the in-box check through it.
    expect(d.match(/inBoxCheck\(/g)).toHaveLength(2)
    expect(d.match(/runCheckAsync\(/g)).toHaveLength(1)
  })

  it('Bun never fetches a package by itself: the driver\'s give-back starts Bun with --no-install', () => {
    const d = drv()
    expect(d).toContain("spawnSync('bun', ['--no-install', 'scripts/cynco-apps.mjs', 'give-back'], { encoding: 'utf-8', timeout: 60_000 })")
    expect(d.match(/spawnSync\('bun', \[/g)).toHaveLength(1)
  })
})
