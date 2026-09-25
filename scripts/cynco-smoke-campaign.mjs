// scripts/cynco-smoke-campaign.mjs
// The smoke campaign (Phase 4 Task 6): a real, one-wave campaign against the
// tiny calc repo (C:/tmp/phase2-smoke) for the live autopoiesis proof. It lays
// out a temp CYNCO_HOME exactly as the runner expects it — the sealed triple
// under heldout/, a fresh campaigns/s1/, the spec under smoke/ — and prints the
// spec path. It does NOT archive the BASE: the runner does that at CALIBRATE.
//
//   CYNCO_HOME=C:/tmp/cynco-home-s1/.cynco \
//     bun scripts/cynco-smoke-campaign.mjs --write --repo C:/tmp/phase2-smoke [--home <dir>]
//
// The home MUST end in `/.cynco`: checkIdentity seals instruments by the path
// shape `/.cynco/heldout/`, and `heldoutDirFor` puts them at
// `<home>/heldout/...`. So the caller passes `C:/tmp/cynco-home-s1/.cynco` as
// CYNCO_HOME (not `C:/tmp/cynco-home-s1`), and the runner, the engine and this
// generator then all agree on one directory.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { WORKER_INVARIANTS, heldoutDirFor } from './cynco-gate-author.mjs'

export const SMOKE_ID = 's1'
const FIXTURES = fileURLToPath(new URL('./__tests__/fixtures/gates/smoke/', import.meta.url))
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')

const MEASURES = `HOW THE BAR MEASURES — build to these definitions exactly

  The bar reads the files of the repo at your commit; nothing is imported or
  run except the parsing of calc.py and test_calc.py.

  S1.1 SHIP NOTES. SHIP.md exists with at least 3 non-empty lines.
  S1.2 VERSION FILE. VERSION exists and, stripped, is MAJOR.MINOR.PATCH
       (three dot-separated integers, e.g. 0.1.0 — nothing else in the file).
  S1.3 CHANGELOG. CHANGELOG.md exists and contains the exact VERSION string.
  S1.4 LICENSE. LICENSE exists with at least 10 lines (a real licence text).
  S1.5 MODULE DOCSTRING. calc.py opens with a module docstring: a string
       literal as the first statement of the file (a function docstring does
       not count — total() already has one).
  S1.6 A TEST FOR THE DOCSTRING. test_calc.py defines a test function whose name
       starts with test_docstring, and it checks that total() is documented.
  S1.7 MAIN GUARD. calc.py contains the line  if __name__ == "__main__":
  S1.8 SHIP NOTES NAME THE VERSION. SHIP.md contains the exact VERSION string.

  Every line is graded independently; the existing tests in test_calc.py must
  stay green.
`

/** The campaign spec for `repo` at `base`, with its instruments under `heldout`. */
export function smokeSpec({ repo, base, heldout }) {
  return {
    id: SMOKE_ID,
    title: 'smoke: ship calc 0.1.0',
    repo,
    base,
    gate: `${heldout}/gate_${SMOKE_ID}.py`,
    perturb: `${heldout}/perturb_${SMOKE_ID}.py`,
    positive: `${heldout}/positive_${SMOKE_ID}.py`,
    suiteBaseline: `${heldout}/suite_baseline_${base.slice(0, 7)}.txt`,
    marker: 'smoke s1 complete',
    keepGreen: 'python -m pytest -q test_calc.py',
    budget: { hoursPerWave: 1, iterations: 300, bashTimeoutMs: 600000, waves: 1 },
    invariants: { ...WORKER_INVARIANTS },
    posiwid: { sourceEditShare: 0.3, commitEvery: 60 },
    sweep: { max: 2 },
    prBase: 'main',
    allow: { newFiles: ['SHIP.md', 'VERSION', 'CHANGELOG.md', 'LICENSE'], edit: ['calc.py', 'test_calc.py'] },
    deny: [],
    measures: MEASURES,
    work: [
      {
        id: 'ship-files',
        title: 'SHIP FILES',
        gateIds: ['S1.1.ship-notes', 'S1.2.version-file', 'S1.3.changelog', 'S1.4.license', 'S1.8.ship-mentions-version'],
        text: 'Write VERSION (0.1.0), SHIP.md (at least 3 lines, naming the version),\n'
          + '   CHANGELOG.md (an entry for the version) and LICENSE (a full licence text,\n'
          + '   at least 10 lines). Commit after each file.',
      },
      {
        id: 'code-hygiene',
        title: 'CODE HYGIENE',
        gateIds: ['S1.5.module-docstring', 'S1.6.tests-cover-total-docstring', 'S1.7.main-guard'],
        text: 'Give calc.py a module docstring and a main guard, and add a\n'
          + '   test_docstring_* test to test_calc.py asserting total() is documented;\n'
          + '   python -m pytest -q test_calc.py stays green.',
      },
    ],
    rules: [],
    ideation: { enabled: false },
    author: 'human',
  }
}

function headOf(repo) {
  const r = runSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { cwd: process.cwd(), env: {}, timeoutMs: 60_000 })
  if (r.fault) throw new Error(`git -C ${repo} rev-parse HEAD did not run (${faultSummary(r.fault)})`)
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(String(r.stdout).trim())) {
    throw new Error(`git -C ${repo} rev-parse HEAD failed: ${String(r.stderr).trim() || String(r.stdout).trim()}`)
  }
  return String(r.stdout).trim()
}

/**
 * Lay out the smoke campaign in `home` (a CYNCO_HOME) and return the spec path.
 * `base` defaults to the repo's HEAD. Writes ONLY under `home`, and refuses the
 * real `~/.cynco` — the smoke run must never share state with a live campaign.
 */
export function writeSmokeCampaign({ home, repo, base } = {}) {
  if (!home) throw new Error('writeSmokeCampaign: no home — pass --home or set CYNCO_HOME')
  if (!repo) throw new Error('writeSmokeCampaign: no repo — pass --repo')
  const h = norm(resolve(home))
  if (h.toLowerCase() === norm(resolve(homedir(), '.cynco')).toLowerCase()) {
    throw new Error(`refusing to write into the real ${h} — point CYNCO_HOME at a temp dir ending in /.cynco`)
  }
  if (!/\/\.cynco$/.test(h)) {
    throw new Error(`home ${h} must end in /.cynco — checkIdentity seals instruments by the /.cynco/heldout/ path shape (e.g. C:/tmp/cynco-home-s1/.cynco)`)
  }
  const r = norm(resolve(repo))
  const sha = base ?? headOf(r)

  const heldout = heldoutDirFor(SMOKE_ID, h)
  mkdirSync(heldout, { recursive: true })
  for (const f of [`gate_${SMOKE_ID}.py`, `perturb_${SMOKE_ID}.py`, `positive_${SMOKE_ID}.py`]) copyFileSync(`${FIXTURES}${f}`, `${heldout}/${f}`)

  const campaignDir = `${h}/campaigns/${SMOKE_ID}`
  rmSync(campaignDir, { recursive: true, force: true })
  mkdirSync(campaignDir, { recursive: true })

  mkdirSync(`${h}/smoke`, { recursive: true })
  const specPath = `${h}/smoke/${SMOKE_ID}.campaign.json`
  writeFileSync(specPath, JSON.stringify(smokeSpec({ repo: r, base: sha, heldout }), null, 2) + '\n', 'utf8')
  return specPath
}

function parseArgs(argv) {
  const out = { write: false, repo: null, home: process.env.CYNCO_HOME || null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') out.write = true
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args.write) throw new Error('usage: bun scripts/cynco-smoke-campaign.mjs --write --repo <path> [--home <dir ending in /.cynco>]')
    console.log(writeSmokeCampaign({ home: args.home, repo: args.repo }))
  } catch (e) {
    console.error(`[smoke] ${e.message}`)
    process.exit(1)
  }
}
