/**
 * A best-of-N winner is not applied through a link in the folder it is applied to (wave 15b; NOW.md:76,
 * the call site P2 left for best-of-N). `git apply` takes a junction in the work tree for a folder
 * (F6), so a patch that adds `out/x.txt` where `out` is a junction a run made writes the file wherever
 * the junction leads, at the harness's integrity. `applyPatch` refuses such an apply: `false`, the
 * loop's single-pass fallback, nothing written. A link that stays inside, and a folder with none,
 * apply as before. (Wave 15b asked harness git to walk the whole work tree, `worktreeLinks`; since
 * wave 15c, check B4-4, the paths the patch writes are walked instead: the second describe.)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch } from '../../bestOfN/sampler.js'

const made: string[] = []
const links: string[] = []
afterEach(() => {
  // Junctions are removed as entries first, so the folder removal below cannot reach through one.
  for (const l of links.splice(0)) { try { rmdirSync(l) } catch { /* already gone with its test */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-apply-links-'))
  made.push(dir)
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' })
  run('git init')
  run('git config user.email "test@test.com"')
  run('git config user.name "Test"')
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n')
  run('git add hello.txt')
  run('git commit -m init')
  return dir
}

const adds = (rel: string) => [
  `diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`, '@@ -0,0 +1 @@', '+from the candidate', '',
].join('\n')

describe('applyPatch and the links of the folder it writes', () => {
  it('refuses to apply through a junction that leads out of the work tree, and writes nothing there', () => {
    const r = repo()
    const outside = mkdtempSync(join(tmpdir(), 'cynco-apply-outside-'))
    made.push(outside)
    const link = join(r, 'out')
    symlinkSync(outside, link, 'junction')
    links.push(link)
    expect(applyPatch(r, adds('out/x.txt'))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('applies as before beside a junction that stays inside the work tree', () => {
    const r = repo()
    mkdirSync(join(r, 'pkg'))
    const link = join(r, 'pkg-link')
    symlinkSync(join(r, 'pkg'), link, 'junction')
    links.push(link)
    expect(applyPatch(r, adds('src/y.txt'))).toBe(true)
    // git writes the line end the machine's core.autocrlf asks for.
    expect(readFileSync(join(r, 'src', 'y.txt'), 'utf-8')).toMatch(/^from the candidate\r?\n$/)
  })

  it('applies as before in a folder with no link', () => {
    const r = repo()
    expect(applyPatch(r, adds('z.txt'))).toBe(true)
    expect(existsSync(join(r, 'z.txt'))).toBe(true)
  })
})

/**
 * Wave 15c, check B4-4: only what the patch writes is judged. `git apply` writes the paths the patch
 * names and nothing else, so a link elsewhere in the mission folder (an install's junction under an
 * ignored node_modules, an `npm link`) cannot be written through; the whole-tree walk refused an
 * honest winner there, and in any folder of more than 200,000 entries, under a page text that said
 * 'failed to apply cleanly'. Every path the patch names (added, changed, deleted, renamed or copied,
 * either side) is walked from the folder down, by its folders' listings: a link on the way refuses
 * the apply, and so does an entry its folder does not list by the name the patch gives it.
 */
describe('applyPatch judges the paths the patch writes (check B4-4)', () => {
  const lines = (...l: string[]) => [...l, ''].join('\n')
  const junction = (r: string, name: string): string => {
    const outside = mkdtempSync(join(tmpdir(), 'cynco-apply-outside-'))
    made.push(outside)
    const link = join(r, name)
    symlinkSync(outside, link, 'junction')
    links.push(link)
    return outside
  }

  it('applies an honest winner beside a link elsewhere in the folder that leads out of it', () => {
    const r = repo()
    junction(r, 'node_modules-link')
    const reasons: string[] = []
    expect(applyPatch(r, adds('src/y.txt'), why => reasons.push(why))).toBe(true)
    expect(reasons).toEqual([])
    expect(existsSync(join(r, 'src', 'y.txt'))).toBe(true)
  })

  it('refuses a patch that writes through a link and says which', () => {
    const r = repo()
    const outside = junction(r, 'out')
    const reasons: string[] = []
    expect(applyPatch(r, adds('out/deeper/x.txt'), why => reasons.push(why))).toBe(false)
    expect(reasons).toEqual(['it writes through a link (out)'])
    expect(existsSync(join(outside, 'deeper'))).toBe(false)
  })

  it('refuses a patch that deletes a file through a link, and the file stays', () => {
    const r = repo()
    const outside = junction(r, 'out')
    writeFileSync(join(outside, 'x.txt'), 'secret\n')
    const del = lines('diff --git a/out/x.txt b/out/x.txt', 'deleted file mode 100644', '--- a/out/x.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-secret')
    expect(applyPatch(r, del)).toBe(false)
    expect(readFileSync(join(outside, 'x.txt'), 'utf-8')).toBe('secret\n')
  })

  it('refuses a rename into a link', () => {
    const r = repo()
    const outside = junction(r, 'out')
    const ren = lines('diff --git a/hello.txt b/out/hello.txt', 'similarity index 100%', 'rename from hello.txt', 'rename to out/hello.txt')
    const reasons: string[] = []
    expect(applyPatch(r, ren, why => reasons.push(why))).toBe(false)
    expect(reasons).toEqual(['it writes through a link (out)'])
    expect(existsSync(join(outside, 'hello.txt'))).toBe(false)
    expect(existsSync(join(r, 'hello.txt'))).toBe(true)
  })

  it('refuses a path that names a link in another case than its folder lists it', () => {
    const r = repo()
    const outside = junction(r, 'out')
    expect(applyPatch(r, adds('OUT/x.txt'))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('refuses a path that names a link with a trailing dot (git refuses that path itself)', () => {
    const r = repo()
    const outside = junction(r, 'out')
    const reasons: string[] = []
    expect(applyPatch(r, adds('out./x.txt'), why => reasons.push(why))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    // Measured 2026-11-24 (git 2.53 for Windows): `error: invalid path 'out./x.txt'`, git's own
    // NTFS check, which the repository's own config can switch off (core.protectNTFS). Since wave 19
    // (check C4-2) the walk refuses the name itself on Windows, before git is asked: the expectation
    // was 'one reason, whoever gives it' and is now the walk's reason (Bun 1.3.13 and Node 24 keep
    // the dot and find nothing: out\dotprobe.txt of wave 19's package D).
    if (process.platform === 'win32') expect(reasons).toEqual(['it names out., which Windows reads as another name'])
    else expect(reasons).toHaveLength(1)
  })

  it.skipIf(process.platform !== 'win32')('refuses a path that names a link by its short (8.3) name, which its folder does not list', () => {
    const r = repo()
    const outside = junction(r, 'outsidelinkname')
    // The short name Windows gave the junction, read off `dir /x` (the column before the long name).
    const listing = execSync('cmd /d /c dir /x /a', { cwd: r, encoding: 'utf-8' })
    const short = /\s(\S+~\d+)\s+outsidelinkname(?:\s|$)/im.exec(listing)?.[1]
    expect(short, `this volume gave the junction no short name:\n${listing}`).toBeTruthy()
    const reasons: string[] = []
    expect(applyPatch(r, adds(`${short}/x.txt`), why => reasons.push(why))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    expect(reasons).toEqual([`it names ${short}, which its folder does not list by that name`])
  })

  it('refuses a patch whose paths it cannot read', () => {
    const r = repo()
    const odd = lines('diff --git a/p q b/r', 'old mode 100644', 'new mode 100755')
    const reasons: string[] = []
    expect(applyPatch(r, odd, why => reasons.push(why))).toBe(false)
    expect(reasons[0]).toMatch(/^its paths could not be read/)
  })

  it('says why when git apply refuses it', () => {
    const r = repo()
    const stale = lines('diff --git a/hello.txt b/hello.txt', '--- a/hello.txt', '+++ b/hello.txt', '@@ -1 +1 @@', '-not what is there', '+changed')
    const reasons: string[] = []
    expect(applyPatch(r, stale, why => reasons.push(why))).toBe(false)
    expect(reasons[0]).toMatch(/^git apply --check refused it: /)
  })
})

/**
 * Wave 19, check C4-1: a hunk's lines are content, never file names. A winner that removes a line
 * starting with '-- ' (a SQL, Lua or Haskell comment) shows it as '--- <text>' in its hunk, and one
 * that adds a line starting with '++ ' as '+++ <text>'. Read as file names they refused an honest
 * winner ('its paths could not be read') or added a made-up path to the walk. The hunks are counted
 * as git apply counts them (the header's line counts); a patch whose hunks do not add up is refused
 * as unreadable, so every line git would read as a name is still read.
 *
 * Check C4-2: on Windows a component that ends in a dot or a space, or holds a backslash, is
 * another name to Windows than it is to the listing (`out.` is `out`), and git writes it as Windows
 * reads it when the repository's own config switches core.protectNTFS off. The walk refuses it.
 */
describe('applyPatch reads hunks as content, and refuses a name Windows reads as another (checks C4-1, C4-2)', () => {
  const lines = (...l: string[]) => [...l, ''].join('\n')
  const junction = (r: string, name: string): string => {
    const outside = mkdtempSync(join(tmpdir(), 'cynco-apply-outside-'))
    made.push(outside)
    const link = join(r, name)
    symlinkSync(outside, link, 'junction')
    links.push(link)
    return outside
  }
  const commit = (r: string, rel: string, text: string) => {
    writeFileSync(join(r, rel), text)
    execSync(`git add ${rel}`, { cwd: r, stdio: 'pipe' })
    execSync(`git commit -m ${rel.replace(/\W/g, '')}`, { cwd: r, stdio: 'pipe' })
  }

  it('applies a winner that removes a "-- " comment line and adds a "++ " line', () => {
    const r = repo()
    commit(r, 'schema.sql', '-- note\ncreate table x (a int);\n')
    const patch = lines(
      'diff --git a/schema.sql b/schema.sql', '--- a/schema.sql', '+++ b/schema.sql',
      '@@ -1,2 +1,2 @@', '--- note', '+++ counter', ' create table x (a int);',
    )
    const reasons: string[] = []
    expect(applyPatch(r, patch, why => reasons.push(why))).toBe(true)
    expect(reasons).toEqual([])
    expect(readFileSync(join(r, 'schema.sql'), 'utf-8').replace(/\r\n/g, '\n')).toBe('++ counter\ncreate table x (a int);\n')
  })

  it('a hunk line that reads like a file header naming a link is content: applied, nothing written through the link', () => {
    const r = repo()
    const outside = junction(r, 'out')
    commit(r, 'notes.txt', '-- a/out/x.txt\nkeep\n')
    const patch = lines(
      'diff --git a/notes.txt b/notes.txt', '--- a/notes.txt', '+++ b/notes.txt',
      '@@ -1,2 +1,2 @@', '--- a/out/x.txt', '+++ b/out/y.txt', ' keep',
    )
    const reasons: string[] = []
    expect(applyPatch(r, patch, why => reasons.push(why))).toBe(true)
    expect(reasons).toEqual([])
    expect(readFileSync(join(r, 'notes.txt'), 'utf-8').replace(/\r\n/g, '\n')).toBe('++ b/out/y.txt\nkeep\n')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    expect(existsSync(join(outside, 'y.txt'))).toBe(false)
  })

  it('a file header after a hunk is still read: a second section that writes through a link is refused', () => {
    const r = repo()
    const outside = junction(r, 'out')
    commit(r, 'notes.txt', 'a\n')
    const patch = lines(
      'diff --git a/notes.txt b/notes.txt', '--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/out/x.txt b/out/x.txt', 'new file mode 100644', '--- /dev/null', '+++ b/out/x.txt', '@@ -0,0 +1 @@', '+x',
    )
    const reasons: string[] = []
    expect(applyPatch(r, patch, why => reasons.push(why))).toBe(false)
    expect(reasons).toEqual(['it writes through a link (out)'])
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('a hunk whose lines do not match its header is refused as unreadable', () => {
    const r = repo()
    // The header promises two old lines and one new; the hunk holds one of each and then a line no
    // hunk can hold.
    const patch = lines('diff --git a/hello.txt b/hello.txt', '--- a/hello.txt', '+++ b/hello.txt', '@@ -1,2 +1 @@', '-hello world', '+x', 'garbage')
    const reasons: string[] = []
    expect(applyPatch(r, patch, why => reasons.push(why))).toBe(false)
    expect(reasons[0]).toMatch(/^its paths could not be read \(a hunk/)
  })

  it('a patch that ends inside a hunk is refused as unreadable', () => {
    const r = repo()
    const patch = lines('diff --git a/hello.txt b/hello.txt', '--- a/hello.txt', '+++ b/hello.txt', '@@ -1,3 +1,3 @@', '-hello world', '+x')
    const reasons: string[] = []
    expect(applyPatch(r, patch, why => reasons.push(why))).toBe(false)
    expect(reasons[0]).toMatch(/^its paths could not be read \(a hunk/)
  })

  it.skipIf(process.platform !== 'win32')('refuses a component with a trailing dot or space, or a backslash, even when the repository switched core.protectNTFS off', () => {
    const r = repo()
    execSync('git config core.protectNTFS false', { cwd: r, stdio: 'pipe' })
    const outside = junction(r, 'out')
    for (const [rel, shown] of [['out./x.txt', 'out.'], ['out /x.txt', 'out '], ['out\\x.txt', 'out\\x.txt'], ['sub/out./x.txt', 'sub/out.']] as const) {
      const reasons: string[] = []
      expect(applyPatch(r, adds(rel), why => reasons.push(why)), rel).toBe(false)
      expect(reasons, rel).toEqual([`it names ${shown}, which Windows reads as another name`])
    }
    expect(readdirSync(outside)).toEqual([])
  })
})

/**
 * Wave 19b (package B's B3): a refused harness-git environment carries three marks (an unopenable
 * `GIT_DIR`, and a command-scope count and parameters git cannot parse), and `isHarnessRefused` is the
 * one test a site makes. `git apply` runs as outside a repository under the `GIT_DIR` mark alone and
 * applies anyway (measured, wave 15b), so applyPatch must read the refusal itself, by any mark, and
 * name it: before, a refusal without the `GIT_DIR` mark reached `git apply` and came back as git's own
 * complaint about the count, a reason that does not say the folder was refused.
 */
describe('applyPatch reads a harness-git refusal by any of its marks (wave 19b)', () => {
  const REFUSED = 'harness git refused the folder (the engine log says why)'

  it('a folder whose .git names another repository is refused by name and nothing is written', () => {
    const r = repo()
    const other = repo()
    rmSync(join(r, '.git'), { recursive: true, force: true })
    writeFileSync(join(r, '.git'), `gitdir: ${join(other, '.git')}\n`)
    const reasons: string[] = []
    expect(applyPatch(r, adds('z.txt'), why => reasons.push(why))).toBe(false)
    expect(reasons).toEqual([REFUSED])
    expect(existsSync(join(r, 'z.txt'))).toBe(false)
    expect(existsSync(join(other, 'z.txt'))).toBe(false)
  })

  for (const mark of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'] as const) {
    it(`an environment refused by ${mark} alone is refused by name, before git apply`, () => {
      const r = repo()
      const before = process.env[mark]
      process.env[mark] = 'harness-git-refused'
      const reasons: string[] = []
      try {
        expect(applyPatch(r, adds('z.txt'), why => reasons.push(why))).toBe(false)
      } finally {
        if (before === undefined) delete process.env[mark]
        else process.env[mark] = before
      }
      expect(reasons).toEqual([REFUSED])
      expect(existsSync(join(r, 'z.txt'))).toBe(false)
    })
  }
})
