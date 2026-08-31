import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { missingFileHint } from '../../tools/impl/pathHint.js'
import { readTool } from '../../tools/impl/read.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * F136 (C6 wave 4, mission c6-wave4-1788187167100): the model asked for
 * gilded/ui/broadcast.py — never existed; the real file is broadsheet.py.
 * "Error: file not found" carried no steering information, so the model
 * retried the phantom path 7 times until the 5-consecutive-failure halt
 * ended the run with zero commits. These tests pin that a missing-file
 * denial names the nearest real sibling and lists the directory.
 */

const TMP = join(tmpdir(), 'localcode-test-pathhint-' + Date.now())

beforeAll(() => {
  mkdirSync(join(TMP, 'gilded', 'ui'), { recursive: true })
  for (const f of ['__init__.py', 'actions.py', 'app.py', 'atlas_view.py', 'broadsheet.py', 'house_tab.py', 'registry.py', 'widgets.py']) {
    writeFileSync(join(TMP, 'gilded', 'ui', f), '# stub\n')
  }
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('missingFileHint', () => {
  it('suggests the near-named sibling for the measured F136 phantom', () => {
    const hint = missingFileHint(join(TMP, 'gilded', 'ui', 'broadcast.py'))
    expect(hint).toContain('file not found')
    expect(hint).toContain('Did you mean: broadsheet.py?')
    expect(hint).toContain('broadsheet.py')
    expect(hint).toContain('Do not retry this path')
  })

  it('lists the directory contents so a wrong guess still teaches', () => {
    const hint = missingFileHint(join(TMP, 'gilded', 'ui', 'zzz_nothing_like_this.xyz'))
    expect(hint).toContain('contains:')
    expect(hint).toContain('atlas_view.py')
    // Nothing is within distance of that name — no misleading suggestion.
    expect(hint).not.toContain('Did you mean')
  })

  it('walks up to the nearest existing ancestor when the directory is missing too', () => {
    const hint = missingFileHint(join(TMP, 'gilded', 'no_such_dir', 'deeper', 'x.py'))
    expect(hint).toContain('does not exist either')
    expect(hint).toContain(join(TMP, 'gilded'))
  })

  it('flows through the Read tool error path', async () => {
    const result = await readTool.execute({ file_path: join(TMP, 'gilded', 'ui', 'broadcast.py') }, TMP)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Did you mean: broadsheet.py?')
  })
})
