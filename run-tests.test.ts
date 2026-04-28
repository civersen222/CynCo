/**
 * Test runner wrapper — works around Bun Windows segfault with
 * deep directory paths in test files. Imports all test suites.
 */
import './engine/macroShim.js'

// Re-export all test files so bun test can find them
const glob = new Bun.Glob('engine/__tests__/**/*.test.ts')
for await (const path of glob.scan('.')) {
  await import(`./${path}`)
}
