// benchmark/true/polyglot/exercise.test.ts
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFileSync as readFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { discoverExercises, assertPristine, stageWorkdir, injectTests, removeTests, unskip, buildPrompt, buildRetryPrompt, truncateTestOutput } from './exercise.js'

const REAL_ROOT = join(import.meta.dirname, '..', '..', 'polyglot-exercises')

// Builds a minimal fake exercises repo: one python exercise "demo".
function makeFakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'polyglot-fake-'))
  const ex = join(root, 'python', 'exercises', 'practice', 'demo')
  mkdirSync(join(ex, '.meta'), { recursive: true })
  mkdirSync(join(ex, '.docs'), { recursive: true })
  writeFileSync(
    join(ex, '.meta', 'config.json'),
    JSON.stringify({ files: { solution: ['demo.py'], test: ['demo_test.py'], example: ['.meta/example.py'] } }),
  )
  writeFileSync(join(ex, '.meta', 'example.py'), 'SECRET = 42\n')
  writeFileSync(join(ex, '.docs', 'instructions.md'), 'Implement demo.\n')
  writeFileSync(join(ex, 'demo.py'), 'def demo():\n    pass\n')
  writeFileSync(join(ex, 'demo_test.py'), 'def test_demo():\n    assert True\n')
  return root
}

describe('discoverExercises', () => {
  it('finds exercises with solution/test file lists from .meta/config.json', () => {
    const root = makeFakeRoot()
    const found = discoverExercises(root)
    expect(found).toHaveLength(1)
    expect(found[0].language).toBe('python')
    expect(found[0].name).toBe('demo')
    expect(found[0].solutionFiles).toEqual(['demo.py'])
    expect(found[0].testFiles).toEqual(['demo_test.py'])
  })

  it('filters by language and exercise name', () => {
    const root = makeFakeRoot()
    expect(discoverExercises(root, { lang: 'go' })).toHaveLength(0)
    expect(discoverExercises(root, { exercise: 'demo' })).toHaveLength(1)
    expect(discoverExercises(root, { exercise: 'nope' })).toHaveLength(0)
  })
})

// Gated on the real nested repo being present (it is not tracked by localcode).
describe.skipIf(!existsSync(REAL_ROOT))('discoverExercises against real repo', () => {
  it("matches aider's published per-language split (225 total)", () => {
    const found = discoverExercises(REAL_ROOT)
    const byLang: Record<string, number> = {}
    for (const e of found) byLang[e.language] = (byLang[e.language] ?? 0) + 1
    expect(byLang).toEqual({ cpp: 26, go: 39, java: 47, javascript: 49, python: 34, rust: 30 })
    expect(found).toHaveLength(225)
  })
})

describe.skipIf(!existsSync(REAL_ROOT))('assertPristine', () => {
  it('passes on a clean exercises repo', () => {
    expect(() => assertPristine(REAL_ROOT)).not.toThrow()
  })
})

describe('assertPristine CRLF guard', () => {
  // A checkout smudged by core.autocrlf=true is git-clean but every bash
  // script carries \r — gradlew dies instantly in the container and all 47
  // java exercises would be recorded as env failures (observed live in the
  // smoke run). The guard probes one canary gradlew.
  function makeRepo(gradlewContent: string): string {
    const root = mkdtempSync(join(tmpdir(), 'polyglot-crlf-'))
    const ex = join(root, 'java', 'exercises', 'practice', 'demo')
    mkdirSync(ex, { recursive: true })
    writeFileSync(join(ex, 'gradlew'), gradlewContent)
    const git = (cmd: string) => execSync(`git -c core.autocrlf=false ${cmd}`, { cwd: root })
    git('init -q')
    git('add -A')
    git('-c user.email=t@t -c user.name=t commit -qm x')
    return root
  }

  it('throws with remediation instructions when gradlew has CRLF', () => {
    const root = makeRepo('#!/bin/sh\r\necho hi\r\n')
    expect(() => assertPristine(root)).toThrow(/CRLF/)
    expect(() => assertPristine(root)).toThrow(/core\.autocrlf false/)
  })

  it('passes when gradlew is LF', () => {
    const root = makeRepo('#!/bin/sh\necho hi\n')
    expect(() => assertPristine(root)).not.toThrow()
  })
})

describe('stageWorkdir', () => {
  it('copies stubs and docs but NEVER .meta or test files', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    expect(existsSync(join(workdir, 'demo.py'))).toBe(true)
    expect(existsSync(join(workdir, '.docs', 'instructions.md'))).toBe(true)
    expect(existsSync(join(workdir, '.meta'))).toBe(false) // reference solutions
    expect(existsSync(join(workdir, 'demo_test.py'))).toBe(false) // hidden tests
  })

  it('re-staging wipes leftovers from a previous stage', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'leftover.txt'), 'junk')
    const again = stageWorkdir(ex, scratch)
    expect(again).toBe(workdir)
    expect(existsSync(join(workdir, 'leftover.txt'))).toBe(false)
  })

  it('excludes nested test files (java-style src/test/... paths)', () => {
    const root = makeFakeRoot()
    const ex = join(root, 'java', 'exercises', 'practice', 'jdemo')
    mkdirSync(join(ex, '.meta'), { recursive: true })
    mkdirSync(join(ex, 'src', 'main', 'java'), { recursive: true })
    mkdirSync(join(ex, 'src', 'test', 'java'), { recursive: true })
    writeFileSync(
      join(ex, '.meta', 'config.json'),
      JSON.stringify({
        files: {
          solution: ['src/main/java/JDemo.java'],
          test: ['src/test/java/JDemoTest.java'],
          example: ['.meta/Ref.java'],
        },
      }),
    )
    writeFileSync(join(ex, 'src', 'main', 'java', 'JDemo.java'), 'class JDemo {}\n')
    writeFileSync(join(ex, 'src', 'test', 'java', 'JDemoTest.java'), 'class JDemoTest {}\n')
    const [jex] = discoverExercises(root, { lang: 'java' })
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(jex, scratch)
    expect(existsSync(join(workdir, 'src', 'main', 'java', 'JDemo.java'))).toBe(true)
    expect(existsSync(join(workdir, 'src', 'test', 'java', 'JDemoTest.java'))).toBe(false)
  })
})

describe('unskip', () => {
  it('enables skipped javascript tests (xtest/xit/xdescribe)', () => {
    const src = "xtest('a', () => {})\nxit('b', () => {})\nxdescribe('c', () => {})\ntest('d', () => {})\n"
    expect(unskip('javascript', src)).toBe(
      "test('a', () => {})\nit('b', () => {})\ndescribe('c', () => {})\ntest('d', () => {})\n",
    )
  })

  it('strips java @Disabled annotation lines but keeps the import', () => {
    const src = 'import org.junit.jupiter.api.Disabled;\nclass T {\n    @Disabled("Remove to run test")\n    @Test\n    void x() {}\n}\n'
    const out = unskip('java', src)
    expect(out).toContain('import org.junit.jupiter.api.Disabled;')
    expect(out).not.toContain('@Disabled(')
    expect(out).toContain('@Test')
  })

  it('leaves other languages untouched', () => {
    const src = '#[ignore]\nfn t() {}\n'
    expect(unskip('rust', src)).toBe(src)
  })
})

describe('injectTests / removeTests', () => {
  it('round-trips: inject writes unskipped pristine tests, remove deletes them', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'demo_test.py'), 'utf-8')).toContain('def test_demo')
    removeTests(ex, workdir)
    expect(existsSync(join(workdir, 'demo_test.py'))).toBe(false)
  })

  it('clobbers an agent-created file that collides with a test name', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'demo_test.py'), 'def test_demo():\n    pass  # tampered\n')
    injectTests(ex, workdir)
    const content = readFs(join(workdir, 'demo_test.py'), 'utf-8')
    expect(content).not.toContain('tampered')
    expect(content).toContain('assert True')
  })
})

describe('injectTests restores scaffolding', () => {
  it('restores tampered scaffolding (fake npm test script) before the verdict run', () => {
    const root = makeFakeRoot()
    // give the fake exercise a scaffold file
    const exDir = join(root, 'python', 'exercises', 'practice', 'demo')
    writeFileSync(join(exDir, 'conftest.py'), '# pristine scaffold\n')
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'conftest.py'), '# TAMPERED\n')
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'conftest.py'), 'utf-8')).toBe('# pristine scaffold\n')
  })

  it('does NOT clobber the agent solution files or agent-created helpers', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'demo.py'), 'def demo():\n    return 42\n')
    writeFileSync(join(workdir, 'helper.py'), 'HELP = True\n')
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'demo.py'), 'utf-8')).toContain('return 42')
    expect(readFs(join(workdir, 'helper.py'), 'utf-8')).toBe('HELP = True\n')
    expect(existsSync(join(workdir, '.meta'))).toBe(false) // still never copied
  })

  it('replaces an agent-created directory squatting on a test filename', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    mkdirSync(join(workdir, 'demo_test.py')) // directory with the test's name
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'demo_test.py'), 'utf-8')).toContain('assert True')
  })

  it('restores binary scaffolding byte-identically (gradle-wrapper.jar style)', () => {
    const root = makeFakeRoot()
    const exDir = join(root, 'python', 'exercises', 'practice', 'demo')
    // bytes that are NOT valid UTF-8 — a utf-8 round-trip would mangle them
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x50, 0x4b, 0x03, 0x04, 0x80, 0xc3, 0x28])
    writeFileSync(join(exDir, 'wrapper.jar'), binary)
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'wrapper.jar'), 'tampered')
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'wrapper.jar')).equals(binary)).toBe(true)
  })

  it('injects JS tests with skips enabled (unskip applied end-to-end)', () => {
    const root = makeFakeRoot()
    const ex = join(root, 'javascript', 'exercises', 'practice', 'jsdemo')
    mkdirSync(join(ex, '.meta'), { recursive: true })
    writeFileSync(
      join(ex, '.meta', 'config.json'),
      JSON.stringify({ files: { solution: ['jsdemo.js'], test: ['jsdemo.spec.js'], example: ['.meta/proof.js'] } }),
    )
    writeFileSync(join(ex, 'jsdemo.js'), 'export const f = () => {}\n')
    writeFileSync(join(ex, 'jsdemo.spec.js'), "xtest('works', () => {})\n")
    const [jsex] = discoverExercises(root, { lang: 'javascript' })
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(jsex, scratch)
    injectTests(jsex, workdir)
    expect(readFs(join(workdir, 'jsdemo.spec.js'), 'utf-8')).toBe("test('works', () => {})\n")
  })
})

describe('buildPrompt', () => {
  it("assembles docs + aider's instruction wording with the solution file list", () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const p = buildPrompt(ex)
    expect(p).toContain('Implement demo.')
    // aider's addendum: "####" separator line, then the instruction wording
    expect(p).toContain('####\n\nUse the above instructions to modify the supplied files: demo.py')
    expect(p).toContain("Don't change the names of existing functions or classes")
    expect(p).toContain("Only use standard libraries, don't suggest installing any packages.")
  })

  it('includes introduction.md and instructions.append.md when present', () => {
    const root = makeFakeRoot()
    const docs = join(root, 'python', 'exercises', 'practice', 'demo', '.docs')
    writeFileSync(join(docs, 'introduction.md'), 'INTRO TEXT\n')
    writeFileSync(join(docs, 'instructions.append.md'), 'APPEND TEXT\n')
    const [ex] = discoverExercises(root)
    const p = buildPrompt(ex)
    expect(p.indexOf('INTRO TEXT')).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('INTRO TEXT')).toBeLessThan(p.indexOf('Implement demo.'))
    expect(p.indexOf('APPEND TEXT')).toBeGreaterThan(p.indexOf('Implement demo.'))
  })
})

describe('truncateTestOutput', () => {
  it('passes short output through untouched', () => {
    const output = 'a\nb\nc'
    expect(truncateTestOutput(output)).toBe(output)
  })

  it('keeps head and tail of long output — failure summaries live at the end', () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const t = truncateTestOutput(output)
    expect(t).toContain('line 0') // head (framework banner / first error)
    expect(t).toContain('line 299') // tail (pytest/gradle failure summary)
    expect(t).not.toContain('line 150\n') // middle omitted
    expect(t).toContain('[... 200 lines omitted ...]')
  })
})

describe('buildRetryPrompt', () => {
  it("feeds truncated test output with aider's exact retry wording", () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const p = buildRetryPrompt(['demo.py'], output)
    expect(p).toContain('line 0')
    expect(p).toContain('line 299') // tail kept — errors live at the end
    expect(p).toContain('See the testing errors above.')
    expect(p).toContain("The tests are correct, don't try and change them.")
    expect(p).toContain('Fix the code in demo.py to resolve the errors.')
  })
})
