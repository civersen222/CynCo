// benchmark/true/polyglot/types.ts
export type Language = 'cpp' | 'go' | 'java' | 'javascript' | 'python' | 'rust'

export const LANGUAGES: Record<Language, { testCommand: string }> = {
  // Commands run inside the Linux container via `bash -lc`, cwd = the exercise workdir.
  // Java uses `bash gradlew` because the exec bit is lost copying from Windows.
  python: { testCommand: 'python3 -m pytest -x -q' },
  javascript: { testCommand: 'npm install --no-audit --no-fund --silent && npm test' },
  go: { testCommand: 'go test ./...' },
  rust: { testCommand: 'cargo test -- --include-ignored' },
  java: { testCommand: 'bash gradlew test' },
  cpp: {
    testCommand:
      'cmake -DEXERCISM_RUN_ALL_TESTS=1 -B build -S . && cmake --build build -j && cd build && ctest --output-on-failure',
  },
}

export interface Exercise {
  language: Language
  name: string
  dir: string // absolute path into benchmark/polyglot-exercises
  solutionFiles: string[] // relative paths from .meta/config.json files.solution
  testFiles: string[] // relative paths from .meta/config.json files.test
}

/** One JSONL line per exercise — the spec's durable record. */
export interface ExerciseRecord {
  language: string
  exercise: string
  passed: boolean
  passedTry: 1 | 2 | null
  durationMs: number
  tryDurationsMs: number[]
  testDurationMs: number
  error?: string
  envFailure?: boolean
}
