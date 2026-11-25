import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { secretPathOf, SECRET_REFUSAL } from '../../tools/secretPaths.js'
import { checkBashSafety } from '../../tools/bashSafety.js'
import { ToolExecutor } from '../../tools/executor.js'
import { cyncoHome } from '../../paths.js'

/**
 * GLM review S1: Read is tier 'auto' with no path check, so the model could
 * read ~/.cynco/tokens.json (the bridge token, which "is Bash"), ~/.ssh or any
 * .env with no approval card — the first link of a no-approval exfiltration
 * chain. The Bash tool's denylist already names .env, ~/.ssh and /etc/shadow;
 * the file tools had nothing. Secret paths now take one of two routes, both
 * decided in the executor before any tier or grade:
 *   - the engine's own token file is refused outright — nothing the model does
 *     needs it, and reading it hands over every scope at once;
 *   - every other secret path needs the user's yes, however the tool's tier or
 *     the project grader would otherwise rate it; where there is no user to ask
 *     (approve-all, as the download gate already treats it) it is refused.
 */
const cwd = mkdtempSync(join(tmpdir(), 'cynco-secret-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }))

describe('secretPathOf', () => {
  it('refuses the engine token file by its resolved path', () => {
    expect(secretPathOf('Read', { file_path: join(cyncoHome(), 'tokens.json') }, cwd)?.action).toBe('refuse')
  })
  it('asks for SSH material, .env files and system credential files', () => {
    expect(secretPathOf('Read', { file_path: join(homedir(), '.ssh', 'id_rsa') }, cwd)?.action).toBe('approve')
    expect(secretPathOf('Ls', { path: join(homedir(), '.ssh') }, cwd)?.action).toBe('approve')
    expect(secretPathOf('Read', { file_path: '.env' }, cwd)?.action).toBe('approve')
    expect(secretPathOf('Read', { file_path: 'api/.env.local' }, cwd)?.action).toBe('approve')
    expect(secretPathOf('Edit', { file_path: '.env' }, cwd)?.action).toBe('approve')
    expect(secretPathOf('Read', { file_path: '/etc/shadow' }, cwd)?.action).toBe('approve')
  })
  it('leaves ordinary paths alone, including names that merely contain env', () => {
    expect(secretPathOf('Read', { file_path: 'src/env.ts' }, cwd)).toBeNull()
    expect(secretPathOf('Read', { file_path: 'docs/environment.md' }, cwd)).toBeNull()
    expect(secretPathOf('Grep', { pattern: 'TOKEN', path: 'src' }, cwd)).toBeNull()
    expect(secretPathOf('Read', { file_path: 'config/tokens.json' }, cwd)).toBeNull()
  })
})

describe('Bash denylist covers the token file', () => {
  it('refuses a command that names ~/.cynco/tokens.json', () => {
    expect(checkBashSafety('cat ~/.cynco/tokens.json').safe).toBe(false)
    expect(checkBashSafety('type C:\\Users\\me\\.cynco\\tokens.json').safe).toBe(false)
    expect(checkBashSafety('cat config/tokens.json').safe).toBe(true)
  })
})

describe('ToolExecutor and secret paths', () => {
  function exec(opts: { approve: boolean; approveAll?: boolean; grader?: any }) {
    const asked: string[] = []
    const ex = new ToolExecutor({
      cwd,
      requestApproval: async (tool) => { asked.push(tool); return opts.approve },
      approveAll: opts.approveAll,
      grader: opts.grader,
    })
    return { ex, asked }
  }
  writeFileSync(join(cwd, '.env'), 'API_KEY=shh\n')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'ok.txt'), 'fine\n')

  it('the token file is refused even when approval would be granted', async () => {
    const { ex, asked } = exec({ approve: true })
    const r = await ex.execute('Read', { file_path: join(cyncoHome(), 'tokens.json') })
    expect(r.isError).toBe(true)
    expect(r.output).toBe(SECRET_REFUSAL)
    expect(asked).toEqual([])
  })

  it('a .env read asks, and a denial is a denial', async () => {
    const { ex, asked } = exec({ approve: false })
    const r = await ex.execute('Read', { file_path: '.env' })
    expect(asked).toEqual(['Read'])
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/denied by user/)
  })

  it('a .env read the user approves goes through', async () => {
    const { ex, asked } = exec({ approve: true })
    const r = await ex.execute('Read', { file_path: '.env' })
    expect(asked).toEqual(['Read'])
    expect(r.isError).toBe(false)
    expect(r.output).toContain('API_KEY=shh')
  })

  it('under approve-all there is no user, so a secret path is refused, not auto-approved', async () => {
    const { ex, asked } = exec({ approve: true, approveAll: true })
    const r = await ex.execute('Read', { file_path: '.env' })
    expect(asked).toEqual([])
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/approval/i)
  })

  it('a project grader calling it safe does not skip the ask', async () => {
    const { ex, asked } = exec({ approve: false, grader: () => ({ level: 'safe', reason: '' }) })
    const r = await ex.execute('Read', { file_path: '.env' })
    expect(asked).toEqual(['Read'])
    expect(r.isError).toBe(true)
  })

  it('an ordinary auto-tier read still runs without a card', async () => {
    const { ex, asked } = exec({ approve: false })
    const r = await ex.execute('Read', { file_path: 'src/ok.txt' })
    expect(asked).toEqual([])
    expect(r.isError).toBe(false)
  })
})

/** A directory link (a junction on Windows), or false when this system cannot make one. */
function linkDir(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (e) {
    console.log(`[test] no directory link could be made here: ${(e as Error).message}`)
    return false
  }
}
const CAN_LINK_DIRS = (() => {
  const d = mkdtempSync(join(tmpdir(), 'linkprobe-'))
  const ok = linkDir(d, join(d, 'l'))
  if (ok) unlinkSync(join(d, 'l'))
  rmSync(d, { recursive: true, force: true })
  return ok
})()

describe('secretPathOf, second arm: nested keys, patch headers and real paths (F242)', () => {
  it('a MultiEdit whose edits are a .env and the token file is refused, not asked', () => {
    const hit = secretPathOf('MultiEdit', {
      edits: [
        { file_path: '.env', old_string: 'a', new_string: 'b' },
        { file_path: join(cyncoHome(), 'tokens.json'), old_string: 'a', new_string: 'b' },
      ],
    }, cwd)
    expect(hit?.action).toBe('refuse')
  })

  it('an ApplyPatch whose header names a .env asks for approval', () => {
    const patch = '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n'
    expect(secretPathOf('ApplyPatch', { patch }, cwd)?.action).toBe('approve')
  })

  it('Bash and the Git tool are still not judged here', () => {
    expect(secretPathOf('Bash', { command: `cat ${join(cyncoHome(), 'tokens.json')}` }, cwd)).toBeNull()
    expect(secretPathOf('Git', { subcommand: 'add', args: '.env' }, cwd)).toBeNull()
  })

  it.skipIf(!CAN_LINK_DIRS)('a Read of the token file through a directory link is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'cynco-secret-link-'))
    const home = join(root, 'state')
    mkdirSync(home)
    writeFileSync(join(home, 'tokens.json'), '{}')
    const alias = join(root, 'alias')
    const before = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try {
      expect(linkDir(home, alias)).toBe(true)
      expect(secretPathOf('Read', { file_path: join(alias, 'tokens.json') }, root)?.action).toBe('refuse')
      expect(secretPathOf('Read', { file_path: join(alias, 'notes.txt') }, root)).toBeNull()
    } finally {
      process.env.CYNCO_HOME = before
      try { unlinkSync(alias) } catch (e) { console.log(`[test] link not removed: ${(e as Error).message}`) }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
