/**
 * How many test files run at once.
 *
 * F207. vitest starts one worker per logical processor (32 on the owner's PC),
 * and several hundred of these tests start processes: `git` for the loop's
 * workspace snapshot, PowerShell for the Bash tool, `bun`, `python`. Measured
 * 2026-11-11 with a probe beside a full run: at 32 workers one `git` spawn
 * cost 130-330 ms against 33 ms on an idle machine and a PowerShell start up
 * to 1.5 s against 156 ms, while a fixed CPU loop did not move (41 to 47 ms).
 * A loop test that makes twenty such spawns went from 1.3 s alone to 4.7 s,
 * and each run a different one crossed vitest's 5 s default: 141 tests over
 * 2.5 s, 1 to 5 red files per run, 122 s. At 16 workers the same spawn cost
 * 60 ms: 598 files green, 82 s (12 workers: the same, 81 s).
 *
 * So on Windows, where creating a process is the expensive thing, the suite
 * runs on half the logical processors. Elsewhere vitest's own default stands:
 * the Linux CI runner has four processors and cheap process creation.
 * `--maxWorkers=N` on the command line still wins.
 */
export function suiteWorkers(platform: string, logicalProcessors: number): number | undefined {
  if (platform !== 'win32') return undefined
  return Math.max(1, Math.floor(logicalProcessors / 2))
}
