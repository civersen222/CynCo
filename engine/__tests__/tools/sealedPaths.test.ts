import { describe, expect, it, mock, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  callTouchesSealed,
  getSealedDirs,
  redactSealed,
  setTaskSealedPaths,
  SEALED_REFUSAL,
} from '../../tools/sealedPaths.js'
import { ToolExecutor } from '../../tools/executor.js'

/**
 * F37, measured on Gilded Wave 9: the run listed the scratch directory, read the
 * held-out gate, and executed it. Finding (ag) had made the gate unwritable and
 * F34 had stopped the refusal from naming it; neither stopped a model that goes
 * looking. These tests are the three layers, each proved to bite on its own.
 */

const made: string[] = []
function gatesDir(): { dir: string; gate: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'))
  made.push(dir)
  const gate = join(dir, 'verify_w9.py').replace(/\\/g, '/')
  writeFileSync(gate, 'MUTATIONS = [("SCHEME_THRESHOLD = 100", "= 101")]\n')
  return { dir: dir.replace(/\\/g, '/'), gate }
}

afterEach(() => {
  setTaskSealedPaths([])
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('layer 1 — a sealed instrument cannot be named', () => {
  it('refuses a Read of the gate', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(callTouchesSealed('Read', { file_path: gate }, dir)).toBe(true)
  })

  it('refuses a Bash command that runs the gate', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(callTouchesSealed('Bash', { command: `python ${gate}` }, dir)).toBe(true)
  })

  it('refuses the gate spelled with backslashes and a different case', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    const windowsy = gate.replace(/\//g, '\\').toUpperCase()
    expect(callTouchesSealed('Bash', { command: `type ${windowsy}` }, dir)).toBe(
      process.platform === 'win32',
    )
  })

  it('refuses a Glob that hunts for the basename anywhere', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(callTouchesSealed('Glob', { pattern: '**/verify_w9.py' }, dir)).toBe(true)
  })

  it('allows an ordinary call that names nothing sealed', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(callTouchesSealed('Bash', { command: 'python -m pytest -q' }, dir)).toBe(false)
    expect(callTouchesSealed('Read', { file_path: `${dir}/../brief.txt` }, dir)).toBe(false)
  })

  it('seals nothing by default, so an ordinary task is untouched', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([])
    expect(callTouchesSealed('Read', { file_path: gate }, dir)).toBe(false)
  })

  /** Scoped to ONE task. A later task must not inherit the last one's seal. */
  it('releases the seal when the next task declares none', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(callTouchesSealed('Read', { file_path: gate }, dir)).toBe(true)
    setTaskSealedPaths([])
    expect(callTouchesSealed('Read', { file_path: gate }, dir)).toBe(false)
  })
})

describe('layer 2 — a sealed instrument cannot be enumerated', () => {
  it('strikes the gate from a directory listing and keeps everything else', () => {
    const { gate } = gatesDir()
    setTaskSealedPaths([gate])
    const listing = 'brief.txt\nverify_w9.py\nnotes.md'
    const out = redactSealed(listing)
    expect(out).not.toContain('verify_w9')
    expect(out).toContain('brief.txt')
    expect(out).toContain('notes.md')
    expect(out).toContain('sealed')
  })

  it('leaves output alone when nothing sealed appears in it', () => {
    const { gate } = gatesDir()
    setTaskSealedPaths([gate])
    const listing = 'brief.txt\nnotes.md'
    expect(redactSealed(listing)).toBe(listing)
  })

  it('redacts nothing when no instrument is sealed', () => {
    setTaskSealedPaths([])
    expect(redactSealed('verify_w9.py')).toBe('verify_w9.py')
  })
})

describe('layer 3 — the parent is sealed only when it holds nothing but gates', () => {
  it('seals a directory whose every entry is a gate', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    expect(getSealedDirs()).toContain(process.platform === 'win32' ? dir.toLowerCase() : dir)
  })

  it('refuses a wildcard read of a sealed gates directory', () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    // Names no sealed basename — layer 1's path match misses it, and there is no
    // filename in the OUTPUT for layer 2 to strike. Only the sealed dir catches it.
    expect(callTouchesSealed('Bash', { command: `cat ${dir}/*.py` }, dir)).toBe(true)
  })

  /**
   * The rule that keeps this honest. Gates have lived in the same scratch
   * directory as the briefs; sealing that directory would refuse the mission its
   * own brief. So the engine measures whether the parent is gates-only instead
   * of assuming it, and says nothing when it is not.
   */
  it('does NOT seal a shared scratch directory that also holds the brief', () => {
    const { dir, gate } = gatesDir()
    writeFileSync(join(dir, 'brief.txt'), 'the mission brief\n')
    setTaskSealedPaths([gate])
    expect(getSealedDirs()).toEqual([])
    expect(callTouchesSealed('Bash', { command: `cat ${dir}/brief.txt` }, dir)).toBe(false)
    // Layers 1 and 2 still hold there.
    expect(callTouchesSealed('Bash', { command: `cat ${gate}` }, dir)).toBe(true)
  })

  it('does not seal a parent it cannot list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sealed-'))
    made.push(dir)
    const gate = join(dir, 'gone', 'verify_w9.py').replace(/\\/g, '/')
    setTaskSealedPaths([gate])
    expect(getSealedDirs()).toEqual([])
  })

  it('does not seal an empty parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sealed-'))
    made.push(dir)
    mkdirSync(join(dir, 'empty'))
    const gate = join(dir, 'empty', 'verify_w9.py').replace(/\\/g, '/')
    setTaskSealedPaths([gate])
    expect(getSealedDirs()).toEqual([])
  })
})

/**
 * Wired end to end. A guard honoured by a function no caller reaches is finding
 * (ag) again, so this drives the real executor and reads the string the model
 * would actually be shown.
 */
describe('the executor refuses a sealed call, and its refusal names nothing (F37)', () => {
  it('refuses to Read the gate and does not disclose its path or contents', async () => {
    const { dir, gate } = gatesDir()
    setTaskSealedPaths([gate])
    const executor = new ToolExecutor({
      cwd: dir, requestApproval: mock(() => Promise.resolve(true)), approveAll: true,
    })
    const r = await executor.execute('Read', { file_path: gate })
    expect(r.isError).toBe(true)
    expect(r.output, `leaked: ${r.output}`).not.toContain('verify_w9')
    expect(r.output).not.toContain('SCHEME_THRESHOLD')
    expect(r.output).toBe(SEALED_REFUSAL)
  })

  /**
   * Layer 2, end to end. The gate here shares a directory with the brief, so
   * layer 3 does not engage and `Ls` is allowed to run — which is exactly the
   * case F37 happened in. The listing must come back without the gate in it.
   */
  it('lists a shared directory without disclosing the gate in it', async () => {
    const { dir, gate } = gatesDir()
    writeFileSync(join(dir, 'brief.txt'), 'the mission brief\n')
    setTaskSealedPaths([gate])
    const executor = new ToolExecutor({
      cwd: dir, requestApproval: mock(() => Promise.resolve(true)), approveAll: true,
    })
    const r = await executor.execute('Ls', { path: dir })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('brief.txt')
    expect(r.output, `leaked: ${r.output}`).not.toContain('verify_w9')
  })

  it('still lets the task read a file that is not sealed', async () => {
    const { dir, gate } = gatesDir()
    const work = join(dir, 'work.py')
    writeFileSync(work, '# ordinary work\n')
    setTaskSealedPaths([gate])
    const executor = new ToolExecutor({
      cwd: dir, requestApproval: mock(() => Promise.resolve(true)), approveAll: true,
    })
    const r = await executor.execute('Read', { file_path: work })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('ordinary work')
  })
})

/**
 * Layer 4 — CONTENT.
 *
 * Layers 1 and 3 refuse a command that SPELLS the gate, its basename, or the
 * directory holding it. A command can read the file and spell none of them:
 * `find ~/.cynco -name '*.py' -exec cat {} +` names only a grandparent, which
 * is not sealed and must not be — sealing it would refuse the mission its own
 * scratch space. Layer 2 then strikes only the lines that mention the
 * filename, so a `cat` of the gate flowed through with the mutation table
 * intact: every anchor, every replacement, which is precisely the thing the
 * withheld-mutation method depends on the model not having.
 */

/** A gate with enough substance to be recognizable, like a real one. */
function realisticGate(): { dir: string; gate: string; text: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sealed4-'))
  made.push(dir)
  const text = [
    'MUTATIONS = [',
    '    ("D1-a", "demand", "witness_drift base probability 0.5 -> 0.6",',
    '     "probability = 0.5 + weight * 0.1",',
    '     "probability = 0.6 + weight * 0.1"),',
    '    ("D2-a", "guard", "apply_drift subtracts where it added",',
    '     "value = value + delta * rate",',
    '     "value = value - delta * rate"),',
    ']',
  ].join('\n')
  const gate = join(dir, 'verify_w9.py').replace(/\\/g, '/')
  writeFileSync(gate, text + '\n')
  return { dir: dir.replace(/\\/g, '/'), gate, text }
}

describe('layer 4 — a sealed instrument cannot be read around', () => {
  it('discards output carrying the gate text, however the command spelled it', () => {
    const { gate, text } = realisticGate()
    setTaskSealedPaths([gate])
    // The command named nothing sealed; the OUTPUT is the whole file.
    const out = redactSealed(text)
    expect(out).not.toContain('witness_drift')
    expect(out).not.toContain('0.6 + weight')
    expect(out).toContain('sealed')
  })

  it('does not fire before a task seals anything', () => {
    const { text } = realisticGate()
    setTaskSealedPaths([])
    expect(redactSealed(text)).toBe(text)
  })

  it('lets the model read the source the gate quotes', () => {
    // The gate quotes the code it mutates, and reading that code is the job.
    // The quotation survives comparison because the gate spells it with the
    // surrounding quotes and comma and the source spells it bare — and even a
    // collision needs two more consecutive neighbours to withhold anything.
    const { gate } = realisticGate()
    setTaskSealedPaths([gate])
    const source = [
      'def witness_drift(char, weight):',
      '    probability = 0.5 + weight * 0.1',
      '    if char.rng.random() < probability:',
      '        value = value + delta * rate',
      '    return value',
    ].join('\n')
    expect(redactSealed(source)).toBe(source)
  })

  it('withholds the whole output rather than the matching lines', () => {
    // A partial redaction of a file's own text is a redaction with a hole, and
    // the hole is where the remaining mutations are.
    const { gate, text } = realisticGate()
    setTaskSealedPaths([gate])
    const out = redactSealed('preamble line one\n' + text + '\ntrailing line')
    expect(out).not.toContain('preamble line one')
    expect(out).not.toContain('D2-a')
  })
})
