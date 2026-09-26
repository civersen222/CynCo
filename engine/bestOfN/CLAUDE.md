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
- **`extractPatch`** (`patchExtractor.ts:18`) — stages everything with `git add -A`, diffs against HEAD, then unstages, returning the diff byte-for-byte (or `''` on no changes / any git failure). Never trimmed: `git apply` needs the newline after the last hunk line (F162). Called once per candidate by `conversationLoop.ts` after the candidate's model loop finishes.
- **`selectWinner`** (`sampler.ts:5`) — filters out candidates with empty patches, sorts by `passRate` descending then `totalTurns` ascending, returns the top candidate or `null`. Called by `conversationLoop.ts` after all candidates have run.
- **`runTests`** (`sampler.ts:25`) — executes `testInfo.command` in a worktree with a 120s timeout, captures stdout+stderr even on non-zero exit, and hands the output to `parseTestOutput`.
- **`applyPatch`** (`sampler.ts:48`) — validates a patch with `git apply --check -` before applying it for real with `git apply -`; returns `false` (not a throw) on either failure so the caller can fall back to single-pass.
- **`detectTests`** (`testDetector.ts:22`) — checks, in order, for pytest config, jest config, vitest config, a non-default `package.json` `scripts.test`, `Cargo.toml`, then `*_test.go` files; returns `{ available: false, ... }` if none match.
- **`WorktreeManager`** (`worktreeManager.ts:91`) — the constructor prunes the repo's stale `cynco-bestofn-*` worktrees and never throws (a failed scan is logged; every git call has a 60 s cap, `GIT_TIMEOUT_MS`); `create()` makes a detached worktree from HEAD in the OS tmpdir (via `mkdtempSync` + `rmSync` + `git worktree add --detach --lock --reason "cynco-bestofn pid=<pid>"`), `cleanup()`/`cleanupAll()` remove them (`git worktree remove --force --force`, falling back to a retried `rmSync` + unlock + `git worktree prune`, logging what it could not remove), `getActive()` returns a copy of the tracked paths, `registered()` parses `git worktree list --porcelain`.
- **`isStaleBestOfNWorktree`** (`worktreeManager.ts:59`) — the prune predicate: basename starts `cynco-bestofn-`, parent is the tmp root, and the worktree is unlocked or its `cynco-bestofn pid=N` lock names a pid that is not running. Any other worktree (the main tree, a phase worktree, one locked for another reason) is never touched.
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
- Two worktrees leaked from 2026-05-28 until Phase 5 although the caller's `finally` ran `cleanupAll()` (F162). Root cause INFERRED from what was left on disk (every root-level file gone, subdirectories and `.git` left), not reproduced: on Windows `git worktree remove` failed while something held a file in the tree, the old fallback's `rmSync` threw partway and the error was swallowed, and `git worktree prune` keeps an entry whose directory still exists. The fix is that failures are logged and every new manager prunes what an earlier one could not; pinned by `engine/__tests__/bestOfN/worktreeManager.test.ts` and `engine/__tests__/bridge/bestOfNCleanup.test.ts`. The caller's `finally` restoring the executor's cwd before `cleanupAll()` is hygiene only (`setCwd` sets a string, holds no handle), not part of the leak fix.
- `WorktreeManager.cleanup()` has a fallback (`git worktree remove --force --force` → retried `rmSync` → `git worktree unlock` → `git worktree prune`); the unlock is load-bearing because every worktree is created locked and a locked entry survives a plain prune. Pinned by the "fallback path" test in `engine/__tests__/bestOfN/worktreeManager.test.ts`.
- The constructor's bare `git worktree prune` drops the admin entry of EVERY unlocked worktree in the repo whose directory is missing, whatever its name — metadata only, never a directory. A worktree on a briefly unreachable drive needs `git worktree repair` afterwards.
- `SamplerConfig` and `SamplerResult` in `types.ts` are exported but not imported anywhere outside this directory — `conversationLoop.ts` builds candidate objects inline instead of constructing a `SamplerResult`, so don't assume those two types reflect the real call shape.
- `detectTests` checks Python/pytest signals before JS/TS ones, so a mixed-language repo with both a `pytest.ini` and a `jest.config.js` will always resolve to pytest.
