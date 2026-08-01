import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Map bun:test imports to vitest so all existing tests work unchanged
    alias: {
      'bun:test': './engine/__tests__/setup/bunTestShim.ts',
      'bun:sqlite': './engine/__tests__/setup/bunSqliteShim.ts',
    },
    include: ['engine/__tests__/**/*.test.ts', 'engine/vsm/**/*.test.ts', 'engine/tools/**/*.test.ts', 'benchmark/true/**/*.test.ts'],
    // cyncoHome first: it redirects ~/.cynco to a temp dir. F58 was the suite
    // writing 117 session journals into the directory the live engine resumes
    // from, so nothing that touches state may load before the redirect.
    // bunShim provides Bun.serve for tests that use it.
    setupFiles: ['engine/__tests__/setup/cyncoHome.ts', 'engine/__tests__/setup/bunShim.ts'],
  },
})
