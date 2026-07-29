import { describe, expect, it, mock } from 'bun:test'
import { ToolExecutor, immutableTargetOf } from '../../tools/executor.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('ToolExecutor', () => {
  it('executes an auto-approve tool without requesting approval', async () => {
    const requestApproval = mock(() => Promise.resolve(true))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Read', { file_path: __filename })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('import')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('requests approval for approval-tier tools', async () => {
    const requestApproval = mock(() => Promise.resolve(true))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Bash', { command: 'echo test' })
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
    expect(result.output.trim()).toBe('test')
  })

  it('returns denial message when user denies', async () => {
    const requestApproval = mock(() => Promise.resolve(false))
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval,
    })

    const result = await executor.execute('Bash', { command: 'echo test' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('denied')
  })

  it('returns error for unknown tool', async () => {
    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval: async () => true,
    })

    const result = await executor.execute('NonExistent', {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('unknown tool')
  })
})

describe('a task cannot rewrite its own specification', () => {
  // Gilded L4.6b: ten minutes in, the run replaced the brief it had been given
  // with a plausible reconstruction of its own, inventing a symbol that exists
  // nowhere in the repo, then spent thirty turns searching for it. Write is
  // risk-rated medium and was auto-approved; the shrink guard keys on >=50%
  // shrinkage, so it catches gutting and misses replacement.
  const mkBrief = () => {
    const dir = mkdtempSync(join(tmpdir(), 'immutable-'))
    const brief = join(dir, 'brief.md')
    writeFileSync(brief, '# The real brief\nDo the thing.\n')
    return { dir, brief }
  }

  it('refuses a Write to a declared-immutable path and leaves it byte-identical', async () => {
    const { dir, brief } = mkBrief()
    const before = readFileSync(brief, 'utf8')
    process.env.LOCALCODE_IMMUTABLE_PATHS = brief
    try {
      const executor = new ToolExecutor({
        cwd: dir, requestApproval: mock(() => Promise.resolve(true)), approveAll: true,
      })
      const result = await executor.execute('Write', {
        file_path: brief, content: '# My own account of the brief\n',
      })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('read-only')
      expect(readFileSync(brief, 'utf8')).toBe(before)
    } finally {
      delete process.env.LOCALCODE_IMMUTABLE_PATHS
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses every editing tool, not just Write', () => {
    const { dir, brief } = mkBrief()
    process.env.LOCALCODE_IMMUTABLE_PATHS = brief
    try {
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit']) {
        expect(immutableTargetOf(tool, { file_path: brief }, dir)).toBe(brief)
      }
    } finally {
      delete process.env.LOCALCODE_IMMUTABLE_PATHS
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still allows reading it, and allows writing everything else', async () => {
    const { dir, brief } = mkBrief()
    process.env.LOCALCODE_IMMUTABLE_PATHS = brief
    try {
      const executor = new ToolExecutor({
        cwd: dir, requestApproval: mock(() => Promise.resolve(true)), approveAll: true,
      })
      const read = await executor.execute('Read', { file_path: brief })
      expect(read.isError).toBe(false)
      expect(read.output).toContain('The real brief')

      const other = await executor.execute('Write', {
        file_path: join(dir, 'notes.md'), content: 'scratch\n',
      })
      expect(other.isError).toBe(false)
    } finally {
      delete process.env.LOCALCODE_IMMUTABLE_PATHS
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches a relative spelling of the same file', () => {
    const { dir, brief } = mkBrief()
    process.env.LOCALCODE_IMMUTABLE_PATHS = brief
    try {
      expect(immutableTargetOf('Write', { file_path: 'brief.md' }, dir)).toBe(brief)
    } finally {
      delete process.env.LOCALCODE_IMMUTABLE_PATHS
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('protects nothing when the variable is unset', () => {
    const { dir, brief } = mkBrief()
    delete process.env.LOCALCODE_IMMUTABLE_PATHS
    try {
      expect(immutableTargetOf('Write', { file_path: brief }, dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
