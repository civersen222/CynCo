# engine/bestOfN

## Purpose
Implements best-of-N candidate sampling for `engine/bridge/conversationLoop.ts`: when enabled, it runs the model loop N times in isolated git worktrees, scores each attempt by test pass rate, and applies only the winning patch to the real working tree. It exists so a risky turn can be retried under different sampling temperature without corrupting the user's actual repo if a candidate goes off the rails. It must never leave a worktree behind (all creation goes through `WorktreeManager.cleanupAll()` in a `finally`) and must never apply a patch that fails `git apply --check` first.

## Key files
| File | Role |
|---|---|
| `types.ts` | Shared types: `TestInfo`, `CandidateResult`, `SamplerConfig`, `SamplerResult` |
| `testDetector.ts` | Sniffs the project root to decide which test framework/command to run |
| `worktreeManager.ts` | Creates/tracks/removes detached git worktrees used to sandbox each candidate |
| `patchExtractor.ts` | Captures a unified diff of all changes (tracked + untracked) in a worktree |
| `sampler.ts` | Runs tests, parses their output, picks the winning candidate, applies its patch |

## Important types & functions
- **`extractPatch`** (`patchExtractor.ts:17`) — stages everything with `git add -A`, diffs against HEAD, then unstages, returning the diff (or `''` on any git failure). Called once per candidate by `conversationLoop.ts` after the candidate's model loop finishes.
- **`selectWinner`** (`sampler.ts:5`) — filters out candidates with empty patches, sorts by `passRate` descending then `totalTurns` ascending, returns the top candidate or `null`. Called by `conversationLoop.ts` after all candidates have run.
- **`runTests`** (`sampler.ts:25`) — executes `testInfo.command` in a worktree with a 120s timeout, captures stdout+stderr even on non-zero exit, and hands the output to `parseTestOutput`.
- **`applyPatch`** (`sampler.ts:48`) — validates a patch with `git apply --check -` before applying it for real with `git apply -`; returns `false` (not a throw) on either failure so the caller can fall back to single-pass.
- **`detectTests`** (`testDetector.ts:22`) — checks, in order, for pytest config, jest config, vitest config, a non-default `package.json` `scripts.test`, `Cargo.toml`, then `*_test.go` files; returns `{ available: false, ... }` if none match.
- **`WorktreeManager`** (`worktreeManager.ts:13`) — `create()` makes a detached worktree from HEAD in the OS tmpdir (via `mkdtempSync` + `rmSync` + `git worktree add --detach`), `cleanup()`/`cleanupAll()` remove them (falling back to `rmSync` + `git worktree prune` if `git worktree remove` fails), `getActive()` returns a copy of the tracked paths.
- **`parseTestOutput`** (`sampler.ts:17`) — thin wrapper over `parseTestSummary` from `../bridge/testSummary.js`, returning `{ passed: 0, total: 0 }` when the framework's output can't be parsed.

## Data flow
1. `conversationLoop.ts` checks `LOCALCODE_BEST_OF_N` and calls `detectTests(cwd)`; if no framework is found, best-of-N is skipped entirely.
2. For each of `bonCount` candidates, `WorktreeManager.create()` makes a fresh detached worktree from HEAD and `conversationLoop` points `this.executor` at it, then runs the model loop with a turn cap and elevated temperature.
3. After the loop, `extractPatch(wtPath)` captures the diff and `runTests(wtPath, testInfo)` scores it; the result is pushed into a `candidates` array (shape matching `CandidateResult`).
4. Once all candidates have run, `selectWinner(candidates)` picks the best one.
5. If a winner exists, `applyPatch(mainCwd, winner.patch)` applies its diff to the real working directory; if apply fails, the caller falls through to a normal single-pass turn.
6. `WorktreeManager.cleanupAll()` runs in a `finally` block so every worktree created in step 2 is removed regardless of outcome.

## Gotchas
- `extractPatch` always runs `git add -A` then `git reset HEAD` even on the read path — a caller that races another git command against the same worktree concurrently will corrupt the diff; this package assumes single-threaded, one-worktree-per-candidate use, as pinned by "leaves the worktree unstaged after extraction" in `engine/__tests__/bestOfN/patchExtractor.test.ts`.
- `applyPatch` never throws on a bad patch — both the check and real apply are wrapped in `try/catch` returning `false` — so callers must check the boolean return rather than relying on exceptions; there is no test covering a malformed-patch case, so treat this as an implicit contract when changing the function.
- `WorktreeManager.create()` calls `rmSync` on the just-created tmpdir before calling `git worktree add`, because `git worktree add` refuses to create into an existing directory — deleting that step will break worktree creation silently until `git` starts throwing.
- `WorktreeManager.cleanup()` has a two-tier fallback (`git worktree remove --force` → manual `rmSync` + `git worktree prune`); the fallback path is exercised only indirectly via `cleanupAll` in `engine/__tests__/bestOfN/worktreeManager.test.ts`, so a broken git binary won't be caught by that suite.
- `SamplerConfig` and `SamplerResult` in `types.ts` are exported but not imported anywhere outside this directory — `conversationLoop.ts` builds candidate objects inline instead of constructing a `SamplerResult`, so don't assume those two types reflect the real call shape.
- `detectTests` checks Python/pytest signals before JS/TS ones, so a mixed-language repo with both a `pytest.ini` and a `jest.config.js` will always resolve to pytest.
