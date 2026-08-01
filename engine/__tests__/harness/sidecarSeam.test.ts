/**
 * The join between the mission sidecar and the thing that verifies assertions.
 *
 * Findings (ah), (aj) and (ai) were each fixed in a different file, and each
 * file's tests pass in isolation while the chain between them stays broken —
 * which is exactly how (ah) survived a day of green suites. The sidecar renders
 * assertions, the driver puts them in a `user.message` frame, `validateCommand`
 * admits or refuses the frame at the wire, `applyHarnessContract` installs it,
 * and `ContractAssertPass` is the only place any of it turns into a measurement.
 * Five components, four seams, and no test crossed one of them.
 *
 * So this file tests the seams and nothing else. It builds the frame the driver
 * actually sends — not a hand-written contract literal, which would test my
 * transcription of the driver rather than the driver's output — and carries it
 * the whole way to a verdict against a real file on disk.
 *
 * The two claims that matter:
 *   1. A withheld command survives the wire and reaches the verifier.
 *   2. It does not appear in anything the model is shown.
 * Both were true before 2026-07-30 and neither was tested, so when the second
 * was fixed by deleting the data, the first failed silently.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMissionAssertions } from '../../../scripts/cynco-contract.mjs'
import { validateCommand } from '../../bridge/commandSchema.js'
import { applyHarnessContract } from '../../bridge/contractAutoCreate.js'
import { globalContract, contractAssertPassTool } from '../../tools/contract.js'

// A qualified name, so the real shell validator admits it whether or not the
// file exists — the point here is the data path, not shell dialect.
const GATE = './scripts/gate.sh'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sidecar-seam-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  globalContract.clear()
})

/** Exactly what the driver builds, from exactly what the sidecar loads. */
function driverFrame(sidecar: unknown, checkCmd: string | undefined = GATE) {
  const taskFile = join(dir, 'brief.md')
  writeFileSync(`${taskFile.replace(/\.md$/, '')}.contract.json`, JSON.stringify(sidecar), 'utf-8')
  const assertions = loadMissionAssertions(taskFile, checkCmd, {
    exists: () => true,
    readFile: (p: string) => require('node:fs').readFileSync(p, 'utf-8'),
  })
  return {
    type: 'user.message',
    text: 'the brief',
    cwd: dir,
    contract: { title: 'Mission: seam', brief: 'the brief', assertions },
  }
}

const CENSUS = { assertions: [{ testCensus: 'tests/test_seam.py', min: 3 }] }

function writeCases(n: number) {
  require('node:fs').mkdirSync(join(dir, 'tests'), { recursive: true })
  const body = Array.from({ length: n }, (_, i) => `def test_case_${i}():\n    assert True\n`).join('\n')
  writeFileSync(join(dir, 'tests', 'test_seam.py'), body, 'utf-8')
}

describe('the frame the driver sends survives the wire', () => {
  it('validateCommand admits a contract carrying a withheld command', () => {
    const v = validateCommand(driverFrame(CENSUS))
    expect(v.ok).toBe(true)
  })

  it('refuses an assertion object missing the text the model reads', () => {
    // The union is `string | { text, command }`. An object with only a command
    // would install an assertion with nothing to render, which is the shape a
    // careless widening of the schema produces.
    const v = validateCommand({
      type: 'user.message', text: 't', cwd: dir,
      contract: { title: 'x', assertions: [{ command: GATE }] },
    })
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('contract')
  })
})

describe('what installs, and what the model is shown', () => {
  it('the withheld command reaches the contract but not its status text', () => {
    const frame = validateCommand(driverFrame(CENSUS))
    expect(frame.ok).toBe(true)
    expect(applyHarnessContract((frame as { command: { contract: never } }).command.contract)).toBe(true)

    // Assertion 0 is the held-out gate; 1 is the census the sidecar authorized.
    expect(globalContract.assertionAt(0)?.command).toBe(GATE)
    expect(globalContract.assertionText(0)).not.toContain(GATE)

    // Finding (aj)'s half: the status block is rendered into the prompt every
    // turn. If the command is anywhere in it, the redaction is decorative.
    const status = globalContract.getStatus()
    expect(status).not.toContain(GATE)
    expect(status).not.toContain('gate.sh')
  })

  it('the census assertion carries no command, so its test file stays editable', () => {
    const frame = validateCommand(driverFrame(CENSUS))
    applyHarnessContract((frame as { command: { contract: never } }).command.contract)
    // A mission ordered to restructure a test file must be able to write it.
    // A command on this assertion would put it in the immutable set.
    expect(globalContract.assertionAt(1)?.command).toBeUndefined()
    expect(globalContract.assertionText(1)).toBe('Test file tests/test_seam.py declares at least 3 test cases')
  })
})

describe('the sidecar assertion becomes a measurement', () => {
  /**
   * The end of the chain. Everything above is plumbing; this is the only test
   * that shows the plumbing carries water. `assessTestsUnmodified` clears its
   * veto on a PASSED assertion, so an assertion that cannot be refused is the
   * same defect as no channel at all — an authorization the run grants itself.
   */
  it('refuses the claim when the file declares fewer cases than the sidecar named', async () => {
    writeCases(2)
    const frame = validateCommand(driverFrame(CENSUS))
    applyHarnessContract((frame as { command: { contract: never } }).command.contract)

    const r = await contractAssertPassTool.execute!({ index: 1 }, dir)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('declares 2 test cases')
    expect(globalContract.assertionAt(1)?.status).toBe('pending')
  })

  it('accepts it when the file declares enough', async () => {
    writeCases(4)
    const frame = validateCommand(driverFrame(CENSUS))
    applyHarnessContract((frame as { command: { contract: never } }).command.contract)

    const r = await contractAssertPassTool.execute!({ index: 1 }, dir)
    expect(r.isError).toBe(false)
    expect(globalContract.assertionAt(1)?.status).toBe('passed')
  })

  it('refuses the claim when the file is gone entirely', async () => {
    // No file written at all. A census assertion on a vanished file must
    // contradict rather than read as "nothing to check".
    const frame = validateCommand(driverFrame(CENSUS))
    applyHarnessContract((frame as { command: { contract: never } }).command.contract)

    const r = await contractAssertPassTool.execute!({ index: 1 }, dir)
    expect(r.isError).toBe(true)
    expect(globalContract.assertionAt(1)?.status).toBe('pending')
  })
})
