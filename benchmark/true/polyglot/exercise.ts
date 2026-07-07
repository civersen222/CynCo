// benchmark/true/polyglot/exercise.ts
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
 * Copy pristine test files from the exercises repo into the workdir,
 * unskipped. ALWAYS overwrites, so an agent-created file with a test's
 * name is clobbered by the pristine copy (anti-tamper).
 */
export function injectTests(ex: Exercise, workdir: string): void {
  for (const rel of ex.testFiles) {
    const pristine = readFileSync(join(ex.dir, rel), 'utf-8')
    const dest = join(workdir, rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, unskip(ex.language, pristine))
  }
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

Use the above instructions to modify the supplied files: ${fileList}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.`
}

const MAX_ERROR_LINES = 100

/** Aider's try-2 message: test output + "the tests are correct" wording. */
export function buildRetryPrompt(solutionFiles: string[], testOutput: string): string {
  const truncated = testOutput.split('\n').slice(0, MAX_ERROR_LINES).join('\n')
  return `${truncated}

####

See the testing errors above.
The tests are correct.
Fix the code in ${solutionFiles.join(', ')} to resolve the errors.`
}
