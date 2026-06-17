import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCivkingsTasks } from './tasks.js'

describe('loadCivkingsTasks', () => {
  it('loads task dirs into TaskDefs with resolved absolute paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    const t1 = join(root, 'alpha')
    mkdirSync(t1)
    writeFileSync(join(t1, 'task.json'), JSON.stringify({
      id: 'alpha',
      prompt: 'Do the thing',
      start_ref: '03b4032',
      hidden_test: 'hidden_test.py',
      timeout_ms: 600000,
      source: 'authored',
    }))
    writeFileSync(join(t1, 'hidden_test.py'), 'def test_x():\n    assert True\n')

    const tasks = loadCivkingsTasks(root)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('alpha')
    expect(tasks[0].prompt).toBe('Do the thing')
    expect(tasks[0].startRef).toBe('03b4032')
    expect(tasks[0].hiddenTestName).toBe('hidden_test.py')
    expect(tasks[0].hiddenTestPath).toBe(join(t1, 'hidden_test.py'))
    expect(tasks[0].timeoutMs).toBe(600000)
    expect(tasks[0].setupPatch).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves an optional setup_patch to an absolute path', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    const t1 = join(root, 'beta')
    mkdirSync(t1)
    writeFileSync(join(t1, 'task.json'), JSON.stringify({
      id: 'beta', prompt: 'p', start_ref: 'HEAD',
      hidden_test: 'hidden_test.py', setup_patch: 'setup.patch',
      timeout_ms: 1000, source: 'mined',
    }))
    writeFileSync(join(t1, 'hidden_test.py'), 'def test_y():\n    assert True\n')
    writeFileSync(join(t1, 'setup.patch'), '')

    const tasks = loadCivkingsTasks(root)
    expect(tasks[0].setupPatch).toBe(join(t1, 'setup.patch'))
    rmSync(root, { recursive: true, force: true })
  })

  it('returns an empty list for an empty tasks dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    expect(loadCivkingsTasks(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})
