/**
 * toolPaths.ts (F242, layer 2): every path one tool call names. The table must cover every tool of the
 * registry; field paths resolve as the tools resolve them; the Git tool is read through the argv it
 * builds; `real()` follows links and never asks the file system about a foreign volume. Every folder a
 * test makes lies under its own mkdtemp root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ALL_TOOLS } from '../../tools/registry.js'
import {
  TOOL_PATH_TABLE, canonPath, currentHomes, insidePath, namePaths, patchPaths, type NameOpts,
} from '../../tools/toolPaths.js'
import { scanArgv, type HomeMap } from '../../tools/shellPaths.js'
import { buildArgv, tokenizeArgs } from '../../tools/impl/git.js'
import { setRunContainment, testContainment } from '../../containment.js'

const W: HomeMap = {
  home: 'C:\\Users\\u', appData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'C:\\Users\\u\\AppData\\Local',
  temp: 'C:\\sb\\run1\\tmp', scratch: 'C:\\sb\\run1\\scratch', user: 'u',
}
const CWD = 'C:\\Users\\u\\proj'
const WOPTS: NameOpts = { platform: 'win32', real: p => p, drives: ['C'] }
const nameW = (tool: string, input: Record<string, unknown>) => namePaths(tool, input, CWD, W, WOPTS)

describe('the table', () => {
  it('has an explicit row for every tool of the registry', () => {
    const missing = ALL_TOOLS.map(t => t.name).filter(n => !(n in TOOL_PATH_TABLE))
    expect(missing).toEqual([])
  })
})

describe('field paths', () => {
  it('each file tool names its key with the table op, resolved against the cwd', () => {
    const cases: Array<[string, string, string]> = [
      ['Read', 'file_path', 'read'], ['ImageView', 'file_path', 'read'], ['IndexResearch', 'file_path', 'read'],
      ['Ls', 'path', 'list'], ['Glob', 'path', 'list'], ['Grep', 'path', 'read'],
      ['Write', 'file_path', 'write'], ['Edit', 'file_path', 'write'], ['ReplaceFunction', 'file_path', 'write'],
      ['NotebookEdit', 'notebook_path', 'write'],
    ]
    for (const [tool, key, op] of cases) {
      const n = nameW(tool, { [key]: 'src\\a.py' })
      expect(n.paths.map(p => [p.path, p.op, p.source]), tool).toEqual([['C:\\Users\\u\\proj\\src\\a.py', op, 'field']])
    }
  })
  it('MultiEdit names every edit and skips malformed ones', () => {
    const n = nameW('MultiEdit', { edits: [{ file_path: 'a.py' }, null, 'x', { old_string: 'y' }, { file_path: 'C:\\Users\\u\\.cache\\b.py' }] })
    expect(n.paths.map(p => [p.path, p.op, p.via])).toEqual([
      ['C:\\Users\\u\\proj\\a.py', 'write', 'edits[0].file_path'],
      ['C:\\Users\\u\\.cache\\b.py', 'write', 'edits[4].file_path'],
    ])
  })
  it('ApplyPatch names added, modified, deleted and renamed files', () => {
    const patch = [
      'diff --git a/new.py b/new.py', 'new file mode 100644', '--- /dev/null', '+++ b/new.py', '@@ -0,0 +1 @@', '+x',
      'diff --git a/mod.py b/mod.py', '--- a/mod.py', '+++ b/mod.py', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/gone.py b/gone.py', 'deleted file mode 100644', '--- a/gone.py', '+++ /dev/null', '@@ -1 +0,0 @@', '-a',
      'diff --git a/old.py b/renamed.py', 'similarity index 100%', 'rename from old.py', 'rename to renamed.py',
      '--- "a/sp\\ ace.py"', '+++ "b/sp\\ ace.py"',
    ].join('\n')
    const pp = patchPaths(patch)
    const has = (raw: string, op: string) => pp.some(p => p.raw === raw && p.op === op)
    expect(has('new.py', 'write')).toBe(true)
    expect(has('b/new.py', 'write')).toBe(true)
    expect(has('mod.py', 'write')).toBe(true)
    expect(has('gone.py', 'delete')).toBe(true)
    expect(has('a/gone.py', 'delete')).toBe(true)
    expect(has('old.py', 'delete')).toBe(true)
    expect(has('renamed.py', 'write')).toBe(true)
    expect(has('sp ace.py', 'write')).toBe(true)
    expect(pp.some(p => p.raw === '/dev/null')).toBe(false)
    const n = nameW('ApplyPatch', { patch })
    expect(n.paths.some(p => p.path === 'C:\\Users\\u\\proj\\gone.py' && p.op === 'delete' && p.via === 'patch:---')).toBe(true)
  })
  it('a file the patch makes a symbolic link (mode 120000) is a link to its one added line (review 2026-11-23)', () => {
    const patch = ['diff --git a/link b/link', 'new file mode 120000', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+D:/DCIM',
      '\\ No newline at end of file', 'diff --git a/x.py b/x.py', '--- a/x.py', '+++ b/x.py', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    const pp = patchPaths(patch)
    const links = pp.filter(p => p.raw === 'link' || p.raw === 'b/link')
    expect(links.length).toBeGreaterThan(0)
    for (const p of links) expect([p.op, p.linkTarget]).toEqual(['link', 'D:/DCIM'])
    expect(pp.find(p => p.raw === 'x.py')?.op).toBe('write')
    const n = nameW('ApplyPatch', { patch })
    expect(n.paths.find(p => p.path === 'C:\\Users\\u\\proj\\link')?.linkTarget).toBe('D:\\DCIM')
    const rel = nameW('ApplyPatch', { patch: patch.replace('+D:/DCIM', '+../x.py') })
    expect(rel.paths.find(p => p.path === 'C:\\Users\\u\\proj\\link')?.linkTarget).toBe('C:\\Users\\u\\x.py')
  })
  it('Glob with ../other/** or an absolute pattern names the fixed prefix as a list path', () => {
    const up = nameW('Glob', { pattern: '../other/**/*.py' })
    expect(up.paths.map(p => [p.path, p.op, p.children])).toEqual([['C:\\Users\\u\\other', 'list', true]])
    expect(up.spellings).toEqual(['../other/**/*.py'])
    const abs = nameW('Glob', { pattern: 'C:/cynco-audit/**' })
    expect(abs.paths.map(p => p.path)).toEqual(['C:\\cynco-audit'])
    expect(nameW('Glob', { pattern: 'src/**/*.py' }).paths).toEqual([])
  })
  it('generic keys: an unknown tool with file_path is a read; filePath and pattern reach paths and spellings', () => {
    const n = nameW('NoSuchTool', { file_path: 'a.txt', filePath: 'b.txt', pattern: 'p*' })
    expect(n.paths.map(p => [p.path, p.op])).toEqual([['C:\\Users\\u\\proj\\a.txt', 'read'], ['C:\\Users\\u\\proj\\b.txt', 'read']])
    expect(n.spellings).toEqual(['p*'])
    expect(nameW('Grep', { pattern: 'x', glob: '*.py' }).spellings).toEqual(['x', '*.py'])
    expect(nameW('LookAt', { file: 'photo.jpg' }).spellings).toEqual(['photo.jpg'])
  })
  it('~/x in a file-tool path is not expanded', () => {
    expect(nameW('Write', { file_path: '~/x' }).paths[0].path).toBe('C:\\Users\\u\\proj\\~\\x')
  })
})

describe('Bash and Git', () => {
  it('Bash puts the command in texts[0]', () => {
    const n = nameW('Bash', { command: 'Remove-Item x' })
    expect(n.texts[0]).toBe('Remove-Item x')
    expect(n.paths.map(p => [p.path, p.op, p.source])).toEqual([['C:\\Users\\u\\proj\\x', 'delete', 'shell']])
  })
  it('Git is read through the argv the tool builds', () => {
    const cases: Array<Record<string, string>> = [
      { subcommand: 'status --porcelain' },
      { subcommand: 'commit', args: '-c user.name=x -m "a b"' },
      { subcommand: 'diff', args: 'HEAD # --output=C:\\out\\x' },
    ]
    for (const input of cases) {
      const rawSub = input.subcommand
      const args = input.args ?? ''
      const subTokens = tokenizeArgs(rawSub)
      const sub = subTokens[0] ?? rawSub
      const argTokens = [...subTokens.slice(1), ...tokenizeArgs(args)]
      const expected = scanArgv(['git', ...buildArgv(sub, argTokens)], CWD, W, { platform: 'win32' })
      const n = nameW('Git', input)
      expect(n.scan).toEqual(expected)
      expect(n.texts).toEqual([`git ${rawSub} ${args}`.trim()])
    }
    expect(nameW('Git', { subcommand: 'diff', args: 'HEAD # --output=C:\\out\\x' }).paths.map(p => [p.path, p.op])).toEqual([['C:\\out\\x', 'write']])
  })
  it('the scan memo: the same input object gives the same scan until the command changes', () => {
    const input: Record<string, unknown> = { command: 'Remove-Item x' }
    const a = nameW('Bash', input)
    const b = nameW('Bash', input)
    expect(b.scan).toBe(a.scan)
    input.command = 'Remove-Item y'
    const c = nameW('Bash', input)
    expect(c.scan).not.toBe(a.scan)
    expect(c.paths[0].path).toBe('C:\\Users\\u\\proj\\y')
  })
})

describe('canonPath and insidePath (lexical, every platform)', () => {
  it('canonPath win32', () => {
    expect(canonPath('\\\\?\\C:\\a', 'win32')).toBe('C:\\a')
    expect(canonPath('\\\\?\\UNC\\s\\sh\\x', 'win32')).toBe('\\\\s\\sh\\x')
    expect(canonPath('C:\\Users\\x\\.cynco.', 'win32')).toBe('C:\\Users\\x\\.cynco')
    expect(canonPath('C:\\Users\\x\\.cynco \\y', 'win32')).toBe('C:\\Users\\x\\.cynco\\y')
    expect(canonPath('C:\\cynco-audit.\\x', 'win32')).toBe('C:\\cynco-audit\\x')
    expect(canonPath('C:\\Windows::$DATA', 'win32')).toBe('C:\\Windows')
    expect(canonPath('C:\\Windows::$INDEX_ALLOCATION', 'win32')).toBe('C:\\Windows')
    expect(canonPath('C:/a/b', 'win32')).toBe('C:\\a\\b')
    expect(canonPath('C:\\a\\..\\b', 'win32')).toBe('C:\\b')
  })
  it('canonPath posix keeps a drive word as written', () => {
    expect(canonPath('/a/b/../c', 'posix')).toBe('/a/c')
    expect(canonPath('D:\\x', 'posix')).toBe('D:\\x')
  })
  it('insidePath', () => {
    expect(insidePath('C:\\Users\\u', 'c:\\users\\U\\.cynco', 'win32')).toBe(true)
    expect(insidePath('/home/U', '/home/u/x', 'posix')).toBe(false)
    expect(insidePath('C:\\a', 'C:\\a', 'win32')).toBe(true)
    expect(insidePath('C:\\', 'C:\\x', 'win32')).toBe(true)
    expect(insidePath('C:\\ab', 'C:\\abc', 'win32')).toBe(false)
    expect(insidePath('/', '/x', 'posix')).toBe(true)
  })
})

describe('real()', () => {
  it('asks the file system about nothing on a foreign volume', () => {
    const throwing = (p: string): string => { throw new Error(`asked about ${p}`) }
    const opts: NameOpts = { platform: 'win32', real: throwing, drives: ['C'], lexicalRoots: ['C:\\nas'] }
    for (const fp of ['\\\\nas\\share\\x', 'D:\\x', 'C:\\nas\\y']) {
      const n = namePaths('Write', { file_path: fp }, CWD, W, opts)
      expect(() => n.paths[0].real()).not.toThrow()
    }
    const asked = namePaths('Write', { file_path: 'C:\\x' }, CWD, W, opts)
    expect(() => asked.paths[0].real()).toThrow(/asked about/)
  })

  describe('through a directory link made in a temp folder', () => {
    let root = ''
    let linkOk = true
    let why = ''
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'toolpaths-')))
      mkdirSync(join(root, 'target'))
      try {
        symlinkSync(join(root, 'target'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch (e) {
        linkOk = false
        why = (e as Error).message
        console.log(`[toolPaths.test] no directory link could be made: ${why}`)
      }
    })
    afterAll(() => {
      if (linkOk) {
        if (process.platform === 'win32') rmdirSync(join(root, 'link'))
        else unlinkSync(join(root, 'link'))
      }
      rmSync(root, { recursive: true, force: true })
    })
    it('resolves to the link target and keeps a tail that does not exist', () => {
      if (!linkOk) { console.log(`[toolPaths.test] skipped: ${why}`); return }
      const n = namePaths('Write', { file_path: join(root, 'link', 'new', 'x.txt') }, root, currentHomes(null))
      expect(n.paths[0].real().toLowerCase()).toBe(join(root, 'target', 'new', 'x.txt').toLowerCase())
    })
  })
})

describe('currentHomes', () => {
  it('with a context: the context home, the sandbox temp and scratch, one cached object', () => {
    const ctx = testContainment({
      missionCwd: resolve('/m/proj'), home: resolve('/m/home'),
      sandbox: { root: resolve('/sb/r1'), home: resolve('/sb/r1/home'), tmp: resolve('/sb/r1/tmp'), scratch: resolve('/sb/r1/scratch') },
      folders: { state: resolve('/m/home/.cynco'), models: resolve('/models'), guard: resolve('/guard'), audit: resolve('/audit') },
    })
    const h = currentHomes(ctx)
    expect(h.home).toBe(resolve('/m/home'))
    expect(h.temp).toBe(resolve('/sb/r1/tmp'))
    expect(h.scratch).toBe(resolve('/sb/r1/scratch'))
    expect(currentHomes(ctx)).toBe(h)
    setRunContainment(ctx)
    try { expect(currentHomes()).toBe(h) } finally { setRunContainment(null) }
  })
  it('with no context: the engine own home, cached', () => {
    const h = currentHomes(null)
    expect(h.home).toBe(homedir())
    expect(h.temp).toBe(tmpdir())
    expect(h.scratch).toBeNull()
    expect(currentHomes(null)).toBe(h)
  })
})

describe.skipIf(process.platform !== 'win32')('Windows: short names and junctions', () => {
  it('the 8.3 short name of an existing system folder is its long name', () => {
    const n = namePaths('Read', { file_path: 'C:\\PROGRA~1' }, 'C:\\', currentHomes(null), { platform: 'win32', drives: ['C'] })
    expect(n.paths[0].real().toLowerCase()).toBe('c:\\program files')
  })
  it('a junction inside a temp folder resolves to its target', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'toolpaths-j-')))
    const target = join(root, 'b')
    const link = join(root, 'a')
    mkdirSync(target)
    symlinkSync(target, link, 'junction')
    try {
      const n = namePaths('Write', { file_path: join(link, 'x.txt') }, root, currentHomes(null), { platform: 'win32' })
      expect(n.paths[0].real().toLowerCase()).toBe(join(target, 'x.txt').toLowerCase())
    } finally {
      rmdirSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
