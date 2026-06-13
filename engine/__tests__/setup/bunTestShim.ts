/**
 * bun:test shim for vitest.
 *
 * Re-exports vitest's API (describe / it / expect / beforeAll / …) so test
 * files written against `bun:test` run unchanged, and adds the one symbol
 * vitest lacks: `mock`. Bun's `mock(fn)` is equivalent to vitest's
 * `vi.fn(fn)` — both return a jest-style spy with a `.mock.calls` record.
 */
import { vi } from 'vitest'

export * from 'vitest'

export const mock = (impl?: (...args: any[]) => any) => vi.fn(impl as any)
