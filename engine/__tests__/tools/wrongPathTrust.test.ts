/**
 * A path that does not exist is the model's guess, not the tool failing
 * (F178, live run 2026-10-13). The file tools answer it with the folder's
 * listing (`missingFileHint`, F136), which is the tool working. Scoring it as
 * a failure let three guessed prompt-file names in one parallel Read batch
 * demote Read for most of a project chat's turn (`[trust] Demoted tools
 * excluded: Read`), and with Read withheld the model read the files through
 * Bash `Get-Content`. The trust score measures "does this tool work right
 * now"; a wrong path says nothing about that, so it is not recorded at all.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolExecutor } from '../../tools/executor.js'
import { ToolScorer } from '../../tools/toolScorer.js'
import { isWrongPathAnswer, MISSING_FILE_PREFIX } from '../../tools/impl/pathHint.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-wrongpath-'))
  writeFileSync(join(dir, 'real.txt'), 'the real note\n')
  const scorer = new ToolScorer()
  const executor = new ToolExecutor({ cwd: dir, requestApproval: async () => true, toolScorer: scorer })
  return { dir, scorer, executor }
}

const fresh = new ToolScorer().getConfidence('Read')

describe('a wrong path is not a tool failure', () => {
  it('three Reads of missing files leave Read undemoted and its score unmoved', async () => {
    const { dir, scorer, executor } = setup()
    for (const name of ['D1-Gallery-Tower.txt', 'D2-Tripod.txt', 'D3-Cantilever-Platform.txt']) {
      const r = await executor.execute('Read', { file_path: join(dir, name) })
      expect(r.isError).toBe(true)
      expect(r.output.startsWith(MISSING_FILE_PREFIX)).toBe(true)
      expect(r.output).toMatch(/real\.txt/) // the answer lists the folder
    }
    expect(scorer.getDemotedTools()).not.toContain('Read')
    expect(scorer.excludeForIteration()).not.toContain('Read')
    expect(scorer.getConfidence('Read')).toBe(fresh)
  })

  it('a missing file under Edit is the same guess and is not scored either', async () => {
    const { dir, scorer, executor } = setup()
    for (let i = 0; i < 3; i++) {
      const r = await executor.execute('Edit', { file_path: join(dir, `nope-${i}.txt`), old_string: 'a', new_string: 'b' })
      expect(r.isError).toBe(true)
    }
    expect(scorer.getDemotedTools()).not.toContain('Edit')
    expect(scorer.getConfidence('Edit')).toBe(fresh)
  })

  it('a Read that works still counts, and a failure that is not a wrong path still counts against the tool', async () => {
    const { dir, scorer, executor } = setup()
    const ok = await executor.execute('Read', { file_path: join(dir, 'real.txt') })
    expect(ok.isError).toBe(false)
    expect(scorer.getConfidence('Read')).toBeGreaterThan(fresh)
    const before = scorer.getConfidence('Read')
    const folder = await executor.execute('Read', { file_path: dir }) // a folder, not a missing file
    expect(folder.isError).toBe(true)
    expect(folder.output.startsWith(MISSING_FILE_PREFIX)).toBe(false)
    expect(scorer.getConfidence('Read')).toBeLessThan(before)
    const editBefore = scorer.getConfidence('Edit')
    const miss = await executor.execute('Edit', { file_path: join(dir, 'real.txt'), old_string: 'no such text', new_string: 'b' })
    expect(miss.isError).toBe(true)
    expect(scorer.getConfidence('Edit')).toBeLessThan(editBefore)
  })

  it('isWrongPathAnswer: only the file tools, only an error, only the not-found answer', () => {
    const answer = `${MISSING_FILE_PREFIX}C:\\p\\x.txt\nC:\\p contains: y.txt`
    for (const t of ['Read', 'Edit', 'MultiEdit', 'ReplaceFunction']) expect(isWrongPathAnswer(t, answer, true)).toBe(true)
    expect(isWrongPathAnswer('Read', answer, false)).toBe(false)
    expect(isWrongPathAnswer('Bash', answer, true)).toBe(false) // a command may print anything
    expect(isWrongPathAnswer('Read', 'Error: C:\\p is a directory, not a file.', true)).toBe(false)
  })
})
