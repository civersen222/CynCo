/**
 * Minimal bun:sqlite shim for vitest.
 *
 * Provides a stub Database class so modules that import bun:sqlite
 * can be loaded without the Bun runtime. The Database is never
 * actually used in tests that hit this shim.
 */
export class Database {
  constructor(_path?: string, _options?: any) {}
  exec(_sql: string): void {}
  query(_sql: string): any {
    return { run: () => {}, all: () => [], get: () => null }
  }
  prepare(_sql: string): any {
    return { run: () => {}, all: () => [], get: () => null }
  }
  close(): void {}
}
