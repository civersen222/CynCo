import { describe, it, expect } from 'vitest'
import { isInsideProject, isIndexableSource } from '../../index/indexer.js'

/**
 * The civkings index had 730 distinct file paths in it and 479 of them did not
 * exist. They looked like this:
 *
 *   ..\..\..\c\tmp\wt_i2e\gilded\ui\actions.py
 *   ..\..\..\tmp\ai_additions.py
 *
 * conversationLoop re-indexes every file the model successfully edits, keyed by
 * `path.relative(cwd, resolve(cwd, file_path))`. For a scratch file or a git
 * worktree outside the repo that expression yields a `..\..` traversal, and the
 * indexer stored it happily — the file was real, just not part of the project.
 *
 * Two costs. The index fills with paths the model cannot open, so CodeIndex
 * answers a query with `schemes.py:120` and the follow-up Read fails, which
 * teaches the model the tool is useless. And one project's index accumulates
 * another project's source.
 */
describe('isInsideProject', () => {
  it('accepts paths within the project', () => {
    expect(isInsideProject('gilded/society/schemes.py')).toBe(true)
    expect(isInsideProject('app.py')).toBe(true)
    expect(isInsideProject('a/b/c/d.ts')).toBe(true)
  })

  it('rejects the traversals that polluted the civkings index', () => {
    expect(isInsideProject('..\\..\\..\\c\\tmp\\wt_i2e\\gilded\\ui\\actions.py')).toBe(false)
    expect(isInsideProject('../../../tmp/ai_additions.py')).toBe(false)
    expect(isInsideProject('..')).toBe(false)
  })

  it('rejects absolute paths, which are not relative to anything', () => {
    expect(isInsideProject('C:\\Users\\civer\\civkings\\app.py')).toBe(false)
    expect(isInsideProject('/home/user/app.py')).toBe(false)
  })

  it('does not reject a legitimate name that merely starts with dots', () => {
    expect(isInsideProject('..hidden/file.py')).toBe(true)
    expect(isInsideProject('.github/workflows/ci.yml')).toBe(true)
  })

  it('rejects empty input rather than indexing the project root', () => {
    expect(isInsideProject('')).toBe(false)
  })
})

/**
 * The same purge turned up a second discrepancy. `walkFiles` only ever collects
 * SOURCE_EXTS, but `reindexFile` indexed whatever the model happened to edit, so
 * the localcode index held `.task_outcome.json` and `.cynco\test-output.txt`.
 * A full re-index silently drops those rows, which means the two entry points
 * disagreed about what the index is — and the incremental one was seeding the
 * semantic search with build droppings.
 */
describe('isIndexableSource', () => {
  it('accepts the source files a full walk would collect', () => {
    expect(isIndexableSource('gilded/society/schemes.py')).toBe(true)
    expect(isIndexableSource('engine/index/indexer.ts')).toBe(true)
    expect(isIndexableSource('src/App.tsx')).toBe(true)
  })

  it('rejects the non-source files reindexFile was admitting', () => {
    expect(isIndexableSource('.task_outcome.json')).toBe(false)
    expect(isIndexableSource('.cynco\\test-output.txt')).toBe(false)
    expect(isIndexableSource('README.md')).toBe(false)
    expect(isIndexableSource('.gitignore')).toBe(false)
  })

  it('is case-insensitive about the extension', () => {
    expect(isIndexableSource('Legacy/MAIN.PY')).toBe(true)
  })

  it('still rejects source files outside the project', () => {
    expect(isIndexableSource('../../../tmp/ai_additions.py')).toBe(false)
    expect(isIndexableSource('C:\\Users\\civer\\civkings\\app.py')).toBe(false)
  })
})
