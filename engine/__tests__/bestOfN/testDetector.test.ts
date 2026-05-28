import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { detectTests } from '../../bestOfN/testDetector.js'

const temps: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-testdetector-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

describe('detectTests', () => {
  it('detects pytest via pytest.ini', () => {
    const root = makeTmp()
    writeFileSync(join(root, 'pytest.ini'), '[pytest]\n')
    const result = detectTests(root)
    expect(result.available).toBe(true)
    expect(result.command).toBe('python -m pytest')
    expect(result.framework).toBe('pytest')
  })

  it('detects jest via jest.config.js', () => {
    const root = makeTmp()
    writeFileSync(join(root, 'jest.config.js'), 'module.exports = {}\n')
    const result = detectTests(root)
    expect(result.available).toBe(true)
    expect(result.command).toBe('npx jest')
    expect(result.framework).toBe('jest')
  })

  it('detects bun/npm test via package.json test script', () => {
    const root = makeTmp()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test' } })
    )
    const result = detectTests(root)
    expect(result.available).toBe(true)
    expect(result.command).toBe('npm test')
    expect(result.framework).toBe('npm')
  })

  it('detects go tests via _test.go files', () => {
    const root = makeTmp()
    writeFileSync(join(root, 'main_test.go'), 'package main\n')
    const result = detectTests(root)
    expect(result.available).toBe(true)
    expect(result.command).toBe('go test ./...')
    expect(result.framework).toBe('go')
  })

  it('returns unavailable for empty project', () => {
    const root = makeTmp()
    const result = detectTests(root)
    expect(result.available).toBe(false)
    expect(result.command).toBe('')
    expect(result.framework).toBe('')
  })
})
