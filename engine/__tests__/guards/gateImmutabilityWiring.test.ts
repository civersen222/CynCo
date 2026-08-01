import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * BLOCKING wire-check: the gate-immutability guard must stay CONNECTED.
 *
 * This guard exists because the defect it protects against has already happened
 * twice, the second time inside the fix for the first.
 *
 * Finding (ac) built the enforcement — `executor.immutableTargetOf` refuses a
 * write to a declared-immutable path — and fed it from `LOCALCODE_IMMUTABLE_PATHS`.
 * It had four unit tests and all of them passed. Nothing in production ever set
 * the variable, and nothing could: the component that knows which files are
 * instruments is the mission driver, a WebSocket client in a different process
 * from the one that reads the environment. So on Gilded UI Wave 0b the agent ran
 * `Edit` on C:/tmp/verify_ui0.py — the gate script named in its own contract
 * assertions — and nothing objected (finding (ag)).
 *
 * Then, fixing (ag): `harnessGatePaths` got six tests, `setTaskImmutablePaths`
 * got four, every one green — and deleting the single line in conversationLoop
 * that joins them left all 51 passing. Two well-tested halves and no test that
 * they are joined is the same defect wearing the shape of its own repair.
 *
 * Unit tests can prove a part works. Only a wiring check can prove it is reached,
 * so this asserts against the real source of the live path.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('gate immutability wiring guard', () => {
  it('conversationLoop derives the gate paths and registers them on a live path', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toContain('harnessGatePaths')
    expect(src).toContain('setTaskImmutablePaths')
    // Derivation is actually invoked with the contract's assertions and the
    // workspace, not merely imported.
    expect(src).toMatch(/harnessGatePaths\(\s*opts\.contract\.assertions,\s*this\.executor\['cwd'\]\s*\)/)
    // ...and the result is handed to the enforcement point.
    expect(src).toMatch(/setTaskImmutablePaths\(gates\)/)
  })

  /**
   * The registration must not sit inside the `if (opts?.contract && ...)` block.
   * These locks are scoped to one task; a later task that declares no gate has to
   * clear the previous task's set, or the agent is refused an edit to a file
   * nothing is currently measuring and gets no way to find out why.
   */
  it('registers on every task, so one task cannot inherit another task lock', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    const call = src.indexOf('setTaskImmutablePaths(gates)')
    expect(call).toBeGreaterThan(-1)
    // The nearest preceding brace-opening line must not be the harness-contract
    // conditional: the call is unconditional, with only a ternary guarding the
    // derivation itself.
    const before = src.slice(0, call)
    const lastIf = before.lastIndexOf('if (opts?.contract && applyHarnessContract(')
    const lastClose = before.lastIndexOf('\n    }')
    expect(lastClose).toBeGreaterThan(lastIf)
  })

  /**
   * The brief is the other instrument, and it is the one finding (ac) was built
   * for. Nothing derives it: it sits outside the contract mechanism entirely, so
   * no assertion names it and `harnessGatePaths` cannot find it. The only
   * component that knows where the brief lives is the driver that read it off
   * disk, so the path has to survive four hops — driver → protocol → main →
   * loop — and a break at any one of them is silent.
   */
  it('the brief path travels from the driver to the enforcement point', () => {
    // 1. The driver names it. `resolve` because the engine compares absolute paths.
    const driver = read('scripts/cynco-mission-driver.mjs')
    expect(driver).toMatch(/readOnlyPaths\s*=\s*\[resolve\(taskFile\)/)
    expect(driver).toMatch(/type: 'user\.message'[\s\S]{0,120}readOnlyPaths/)

    // 2. The wire protocol carries it.
    expect(read('engine/bridge/protocol.ts')).toMatch(/readOnlyPaths\?: string\[\]/)

    // 3. The command handler forwards it rather than dropping it on the floor.
    expect(read('engine/main.ts')).toMatch(/readOnlyPaths: command\.readOnlyPaths/)

    // 4. The loop unions it with the derived gates — not either-or.
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toMatch(/opts\?\.readOnlyPaths \?\? \[\]/)
    const declared = src.indexOf('opts?.readOnlyPaths ?? []')
    const register = src.indexOf('setTaskImmutablePaths(gates)')
    expect(declared).toBeGreaterThan(-1)
    expect(declared).toBeLessThan(register)
  })

  it('the enforcement point still consults the task-registered paths', () => {
    const src = read('engine/tools/executor.ts')
    expect(src).toContain('export function setTaskImmutablePaths')
    // The union is the fix. Reverting immutablePaths() to env-only is the
    // original defect, and it is invisible to every test that only sets the
    // environment variable.
    expect(src).toMatch(/return \[\.\.\.fromEnv, \.\.\.taskImmutablePaths\]/)
    // Every editing tool, not just Write.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit']) {
      expect(src).toContain(`'${tool}'`)
    }
  })
})

/**
 * BLOCKING wire-check: the SEAL must stay connected (F37).
 *
 * Same lesson as the guard above, one permission further out. Read-only was the
 * wrong shape for a held-out gate: on Gilded Wave 9 the run listed the scratch
 * directory, read `verify_s9.py`, executed it, and then wrote what it had
 * learned into its own commit message — "mutation testing with -x stops at
 * first failure", "431 other tests", both facts about the gate rather than about
 * the game. Every existing protection held and none of them applied, because
 * they all guard writing, and `immutableTargetOf`'s refusal says in as many
 * words "You may Read it as often as you like".
 *
 * The seal has three layers and any one alone leaves a hole, so this checks that
 * all three are reached from the live path, and that the seal is derived from
 * the WITHHELD assertions only — sealing a visible command's script would hide a
 * file whose command the model was told out loud.
 */
describe('sealed instrument wiring guard', () => {
  it('conversationLoop derives the withheld gates and seals them on every task', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toMatch(/withheldGatePaths\(opts\.contract\.assertions, this\.executor\['cwd'\]\)/)
    expect(src).toMatch(/setTaskSealedPaths\(sealed\)/)
    // Unconditional, like the immutable set: a task carrying no withheld gate
    // must CLEAR the last one's seal, and a refusal that by design cannot name
    // its file is the worst possible thing to leave behind for the next task.
    const call = src.indexOf('setTaskSealedPaths(sealed)')
    expect(call).toBeGreaterThan(-1)
    const before = src.slice(0, call)
    expect(before.lastIndexOf('\n    }'))
      .toBeGreaterThan(before.lastIndexOf('if (opts?.contract && applyHarnessContract('))
  })

  it('seals only the withheld form, never a command the model was told', () => {
    const src = read('engine/bridge/contractAutoCreate.ts')
    expect(src).toContain('export function withheldGatePaths')
    // A plain-string assertion states its command in its own text. Filtering to
    // the object form carrying a `command` is what makes this the withheld set;
    // dropping the filter would seal every gate, including visible ones.
    expect(src).toMatch(/typeof a !== 'string' && Boolean\(a\.command\)/)
  })

  it('the executor reaches both enforcement layers of the seal', () => {
    const src = read('engine/tools/executor.ts')
    // Layer 1: the refusal, and it must come BEFORE the immutable check, whose
    // message invites the model to read the file.
    expect(src).toContain('callTouchesSealed(toolName, input, this.cwd)')
    expect(src).toContain('SEALED_REFUSAL')
    expect(src.indexOf('callTouchesSealed')).toBeLessThan(src.indexOf('immutableTargetOf(toolName'))
    // Layer 2: every tool's output is redacted, and before the cap — a result
    // truncated first could be truncated in the middle of a redaction.
    expect(src).toMatch(/capToolResult\(redactSealed\(result\.output\)/)
  })

  it('the seal names nothing, in the refusal or in the log', () => {
    expect(read('engine/tools/sealedPaths.ts')).toContain('export const SEALED_REFUSAL')
    // The console line counts sealed instruments; the named list is filtered
    // down to the readable ones. An engine log is shipped into trajectories, and
    // a path printed there is a path that can find its way back to a model.
    const src = read('engine/bridge/conversationLoop.ts')
    expect(src).toMatch(/gates\.filter\(g => !sealed\.includes\(g\)\)/)
    expect(src).toMatch(/\$\{sealed\.length\} sealed instrument/)
  })
})
