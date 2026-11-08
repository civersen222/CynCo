import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
