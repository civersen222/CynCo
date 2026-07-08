// benchmark/true/polyglot/exercise.ts
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { execSync } from 'node:child_process'
import { LANGUAGES, type Exercise, type Language } from './types.js'

/**
 * Discover exercises from an aider polyglot-benchmark checkout.
 * Layout: <root>/<lang>/exercises/practice/<name>/.meta/config.json
 */
export function discoverExercises(
  root: string,
  filter?: { lang?: string; exercise?: string },
): Exercise[] {
  const out: Exercise[] = []
  for (const lang of Object.keys(LANGUAGES) as Language[]) {
    if (filter?.lang && lang !== filter.lang) continue
    const practice = join(root, lang, 'exercises', 'practice')
    if (!existsSync(practice)) continue
    for (const name of readdirSync(practice).sort()) {
      if (filter?.exercise && name !== filter.exercise) continue
      const dir = join(practice, name)
      const configPath = join(dir, '.meta', 'config.json')
      if (!existsSync(configPath)) continue
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      out.push({
        language: lang,
        name,
        dir,
        solutionFiles: config.files.solution,
        testFiles: config.files.test,
      })
    }
  }
  return out
}

/**
 * Validity guard: a dirty exercises repo means stubs or hidden tests were
 * mutated (the retired 2025 adapter did exactly that) — results would be
 * unattributable. Refuse to run.
 */
export function assertPristine(root: string): void {
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8' }).trim()
  if (status) {
    throw new Error(
      `exercises repo is not pristine — refusing to run.\n` +
        `Fix with: git -C "${root}" checkout -- . && git -C "${root}" clean -fdx\n${status}`,
    )
  }
  // CRLF guard: a checkout smudged by core.autocrlf=true is git-clean but
  // every bash script carries \r, which kills gradlew instantly under the
  // container's Linux bash — all 47 java exercises would be recorded as env
  // failures (observed live). Probe one canary gradlew.
  const practice = join(root, 'java', 'exercises', 'practice')
  if (existsSync(practice)) {
    for (const name of readdirSync(practice).sort()) {
      const gradlew = join(practice, name, 'gradlew')
      if (!existsSync(gradlew)) continue
      if (readFileSync(gradlew, 'utf-8').includes('\r')) {
        throw new Error(
          `exercises checkout has CRLF line endings (${gradlew}) — bash scripts break in the container.\n` +
            `Fix with: git -C "${root}" config core.autocrlf false && ` +
            `git -C "${root}" rm -rq --cached . && git -C "${root}" reset --hard`,
        )
      }
      break // one canary is enough — the whole checkout shares one smudge state
    }
  }
}

/**
 * Stage an isolated agent workdir under scratchRoot: full exercise dir MINUS
 * `.meta/` (contains reference solutions — CynCo has Read/Grep and would find
 * them) and MINUS the hidden test files (injected only between tries).
 * Always starts from a wiped directory so retries can't inherit state.
 */
export function stageWorkdir(ex: Exercise, scratchRoot: string): string {
  const workdir = join(scratchRoot, `${ex.language}-${ex.name}`)
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  const excluded = new Set(ex.testFiles.map((f) => f.split('/').join(sep)))
  cpSync(ex.dir, workdir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ex.dir, src)
      if (rel === '') return true
      if (rel === '.meta' || rel.startsWith(`.meta${sep}`)) return false
      if (excluded.has(rel)) return false
      return true
    },
  })
  return workdir
}

/**
 * Enable the tests aider enables. Exercism ships most tests skipped
 * (JS `xtest`, Java `@Disabled`); rust/cpp are handled by test-command flags.
 */
export function unskip(language: Language, src: string): string {
  if (language === 'javascript') {
    return src
      .replace(/\bxtest\(/g, 'test(')
      .replace(/\bxit\(/g, 'it(')
      .replace(/\bxdescribe\(/g, 'describe(')
  }
  if (language === 'java') {
    return src
      .split('\n')
      .filter((line) => !line.trim().startsWith('@Disabled'))
      .join('\n')
  }
  return src
}

/**
 * Injects pristine tests AND restores all non-solution scaffolding (anti-tamper:
 * a fake `npm test` script or patched `gradlew` is clobbered before every verdict
 * run). Agent-created helper files and the solution files themselves are preserved.
 *
 * Walks the pristine exercise dir recursively and copies EVERY file into the
 * workdir, overwriting, EXCEPT:
 *  - anything under `.meta/` (never copied — reference solutions)
 *  - files listed in `ex.solutionFiles` (the agent's work — must NOT be clobbered)
 * Test files (`ex.testFiles`) get `unskip` applied; all other files are verbatim.
 * Before writing each file, any same-named directory is removed so a squatting
 * directory doesn't cause EISDIR.
 */
export function injectTests(ex: Exercise, workdir: string): void {
  const solutionSet = new Set(ex.solutionFiles)
  const testSet = new Set(ex.testFiles)

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(ex.dir, abs).split(sep).join('/')
      // skip .meta entirely
      if (rel === '.meta' || rel.startsWith('.meta/')) continue
      if (entry.isDirectory()) {
        walk(abs)
      } else {
        // skip solution files — agent's work must not be clobbered
        if (solutionSet.has(rel)) continue
        const dest = join(workdir, rel.split('/').join(sep))
        // remove any squatting directory before writing
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dirname(dest), { recursive: true })
        if (testSet.has(rel)) {
          writeFileSync(dest, unskip(ex.language, readFileSync(abs, 'utf-8')))
        } else {
          // Buffer copy — scaffolding includes binaries (gradle-wrapper.jar);
          // a UTF-8 round-trip would corrupt them.
          writeFileSync(dest, readFileSync(abs))
        }
      }
    }
  }

  walk(ex.dir)
}

/** Delete injected test files so they are unreadable while the agent runs. */
export function removeTests(ex: Exercise, workdir: string): void {
  for (const rel of ex.testFiles) {
    rmSync(join(workdir, rel.split('/').join(sep)), { force: true })
  }
}

/**
 * Aider's exercise prompt: .docs/introduction.md (if any) + instructions.md +
 * instructions.append.md (if any), followed by aider's exact instruction
 * wording. This is the ONLY harness-supplied instruction text (as-shipped rule).
 */
export function buildPrompt(ex: Exercise): string {
  const docs = join(ex.dir, '.docs')
  const parts: string[] = []
  for (const f of ['introduction.md', 'instructions.md', 'instructions.append.md']) {
    const p = join(docs, f)
    if (existsSync(p)) parts.push(readFileSync(p, 'utf-8'))
  }
  const fileList = ex.solutionFiles.join(', ')
  return `${parts.join('\n\n')}

####

Use the above instructions to modify the supplied files: ${fileList}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.`
}

const MAX_HEAD_LINES = 20
const MAX_TAIL_LINES = 80

/**
 * Documented deviation from aider (which feeds full test output): local-model
 * context is finite, so long output keeps the head (framework banner / first
 * error) and the tail (where pytest/gradle/cargo put failure summaries).
 */
export function truncateTestOutput(output: string): string {
  const lines = output.split('\n')
  if (lines.length <= MAX_HEAD_LINES + MAX_TAIL_LINES) return output
  const omitted = lines.length - MAX_HEAD_LINES - MAX_TAIL_LINES
  return [
    ...lines.slice(0, MAX_HEAD_LINES),
    `[... ${omitted} lines omitted ...]`,
    ...lines.slice(-MAX_TAIL_LINES),
  ].join('\n')
}

/** Aider's try-2 message: test output + aider's exact retry wording. */
export function buildRetryPrompt(solutionFiles: string[], testOutput: string): string {
  return `${truncateTestOutput(testOutput)}

####

See the testing errors above.
The tests are correct, don't try and change them.
Fix the code in ${solutionFiles.join(', ')} to resolve the errors.`
}
