import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'
import { suiteWorkers } from './engine/__tests__/setup/suiteWorkers.js'

export default defineConfig({
  test: {
    // Half the logical processors on Windows, vitest's default elsewhere:
    // at one worker per processor the suite waits on process creation and a
    // different test crosses the 5 s default each run (F207).
    maxWorkers: suiteWorkers(process.platform, availableParallelism()),
    // Map bun:test imports to vitest so all existing tests work unchanged
    alias: {
      'bun:test': './engine/__tests__/setup/bunTestShim.ts',
      'bun:sqlite': './engine/__tests__/setup/bunSqliteShim.ts',
    },
    // `scripts/__tests__/**/*.test.mjs` is here because the harness scripts are
    // plain .mjs and their tests are too. Without this glob a test file under
    // scripts/ is not merely unrun — `npx vitest run <that path>` answers "No
    // test files found, exiting with code 1", which is easy to read as a
    // toolchain hiccup rather than as a suite that never covered the driver.
    include: [
      'engine/__tests__/**/*.test.ts',
      'engine/vsm/**/*.test.ts',
      'engine/tools/**/*.test.ts',
      'benchmark/true/**/*.test.ts',
      'scripts/__tests__/**/*.test.mjs',
    ],
    // cyncoHome first: it redirects ~/.cynco to a temp dir. F58 was the suite
    // writing 117 session journals into the directory the live engine resumes
    // from, so nothing that touches state may load before the redirect.
    // bunShim provides Bun.serve for tests that use it.
    // hostEnv clears every LOCALCODE_* the launching shell exports, so the
    // suite runs on the engine's defaults on the owner's PC as it does on CI
    // and never reaches the owner's live services (F206).
    // noLiveServices makes fetch to this machine's own service ports (Ollama,
    // the model server, the engine, the embedding service) fail as a closed
    // port does, which is what a CI runner has there (F206).
    // missionEnv clears LOCALCODE_MISSION_* so the suite reads as interactive
    // even when a mission engine's child runs it (Phase 5 Task 1, review I1).
    setupFiles: [
      'engine/__tests__/setup/cyncoHome.ts',
      'engine/__tests__/setup/hostEnv.ts',
      'engine/__tests__/setup/noLiveServices.ts',
      'engine/__tests__/setup/missionEnv.ts',
      'engine/__tests__/setup/bunShim.ts',
    ],
  },
})
