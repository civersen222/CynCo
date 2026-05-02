import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Map bun:test imports to vitest so all existing tests work unchanged
    alias: {
      'bun:test': 'vitest',
    },
    include: ['engine/__tests__/**/*.test.ts'],
  },
})
