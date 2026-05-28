import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { TestInfo } from './types.js'

function hasPyFiles(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((f) => f.endsWith('.py'))
  } catch {
    return false
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

export function detectTests(projectRoot: string): TestInfo {
  // --- Python / pytest ---
  if (existsSync(join(projectRoot, 'pytest.ini'))) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }
  if (existsSync(join(projectRoot, 'conftest.py'))) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }
  const pyproject = join(projectRoot, 'pyproject.toml')
  if (existsSync(pyproject) && readFileSafe(pyproject).includes('[tool.pytest')) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }
  const setupCfg = join(projectRoot, 'setup.cfg')
  if (existsSync(setupCfg) && readFileSafe(setupCfg).includes('[tool:pytest]')) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }
  if (hasPyFiles(join(projectRoot, 'tests'))) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }

  // --- JS/TS: jest ---
  const jestGlobs = ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs']
  if (jestGlobs.some((f) => existsSync(join(projectRoot, f)))) {
    return { available: true, command: 'npx jest', framework: 'jest' }
  }

  // --- JS/TS: vitest ---
  const vitestGlobs = [
    'vitest.config.js',
    'vitest.config.ts',
    'vitest.config.cjs',
    'vitest.config.mjs',
  ]
  if (vitestGlobs.some((f) => existsSync(join(projectRoot, f)))) {
    return { available: true, command: 'npx vitest run', framework: 'vitest' }
  }

  // --- package.json test script ---
  const pkgPath = join(projectRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSafe(pkgPath))
      const testScript: string = pkg?.scripts?.test ?? ''
      const defaultError = 'echo "Error: no test specified"'
      if (testScript && !testScript.includes(defaultError)) {
        return { available: true, command: `npm test`, framework: 'npm' }
      }
    } catch {
      // ignore parse errors
    }
  }

  // --- Rust / cargo ---
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return { available: true, command: 'cargo test', framework: 'cargo' }
  }

  // --- Go ---
  try {
    const entries = readdirSync(projectRoot)
    if (entries.some((f) => f.endsWith('_test.go'))) {
      return { available: true, command: 'go test ./...', framework: 'go' }
    }
  } catch {
    // ignore read errors
  }

  return { available: false, command: '', framework: '' }
}
