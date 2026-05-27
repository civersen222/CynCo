import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Map bun:test imports to vitest so all existing tests work unchanged
    alias: {
      'bun:test': 'vitest',
    },
    include: ['engine/__tests__/**/*.test.ts'],
    // Provide Bun.serve shim so tests that use Bun.serve run under vitest
    setupFiles: ['engine/__tests__/setup/bunShim.ts'],
  },
})
