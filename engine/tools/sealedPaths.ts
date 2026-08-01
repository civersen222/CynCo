/**
 * F37: the held-out gate must be unreachable, not merely unwritable.
 *
 * Measured on Gilded Wave 9. The brief promised the model that the gate "is not
 * yours to run and you are not told what it is". Finding (ag) had already made
 * the gate script read-only, and F34 had already stopped the refusal message
 * from naming it. The run found it anyway: it listed `C:/tmp`, read
 * `verify_s9.py`, and executed it. Its own commit `18e8037` proves the read —
 * the message explains that "mutation testing with -x stops at first failure"
 * and counts "431 other tests", both of which are facts about the gate and not
 * about the game under test.
 *
 * A gate file lists every withheld mutation WITH its anchor and replacement.
 * A model that reads it can write tests pinning those exact strings and
 * satisfying nothing else, which is the precise failure the withheld-mutation
 * method exists to detect. Once the gate has been read, its score stops
 * measuring "do these tests pin the rule" and starts measuring "can a model
 * shown thirteen mutations defeat thirteen mutations" — a different and much
 * easier question. The number still prints; it just means something else now.
 *
 * Read-only was the wrong shape of protection. `immutableTargetOf` in
 * executor.ts guards WRITES, and its refusal says, correctly for a brief and
 * disastrously for a gate, "You may Read it as often as you like." The brief is
 * evidence the model must be able to consult. The gate is evidence the model
 * must never see. Those are two different permissions and this module is the
 * second one.
 *
 * Three layers, because any one of them alone is a redaction with a hole:
 *
 *  1. REFERENCE. Any tool input path resolving to a sealed file, and any Bash
 *     command whose text names a sealed file, its basename, or the directory
 *     holding it, is refused.
 *  2. ENUMERATION. Every sealed basename is struck from every tool's output, so
 *     `ls`, `Glob`, and `Grep` cannot report that the file is there. Layer 1
 *     cannot do this: `ls C:/tmp` names nothing sealed on the way in.
 *  3. LOCATION. Gates live in a directory that holds nothing but gates, so
 *     sealing the parent in layer 1 costs the mission nothing it wanted. This
 *     is what closes `cat <dir>/*.py`, which layer 1 misses (the command names
 *     no sealed basename) and layer 2 cannot help with (the output is file
 *     content, which contains no filename to strike). That directory is the
 *     harness's responsibility, not the engine's, and the engine says so by
 *     refusing the parent as well as the file.
 *
 * The refusal names nothing — F34's lesson, one level out. It says a sealed
 * instrument was named and the call was refused, so the model learns it was
 * measured and stops rather than retrying forever, and learns no more.
 */

import { readdirSync } from 'node:fs'

/** Scoped to ONE task, like the immutable set. A later task inherits nothing. */
let taskSealedPaths: string[] = []
/** Parents that hold nothing but sealed files — see `setTaskSealedPaths`. */
let sealedDirs: string[] = []

/** Win32 folds case; two authors spell the same path with different slashes. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function basenameOf(p: string): string {
  const s = norm(p)
  return s.slice(s.lastIndexOf('/') + 1)
}

function parentOf(p: string): string {
  const s = norm(p)
  const cut = s.lastIndexOf('/')
  return cut <= 0 ? '' : s.slice(0, cut)
}

/**
 * Declare the withheld instruments for the current task.
 *
 * Only files a mission must never see belong here. The brief it is measured
 * against does NOT: that one is `setTaskImmutablePaths`, readable and unwritable.
 */
export function setTaskSealedPaths(
  paths: string[],
  listDir: (d: string) => string[] = (d) => readdirSync(d),
): void {
  taskSealedPaths = paths.map(p => p.replace(/\\/g, '/')).filter(Boolean)

  // Layer 3. A parent is sealed only when it holds NOTHING BUT sealed files —
  // that is what makes it a gates directory rather than a scratch directory.
  //
  // The alternative, sealing any parent below some depth, was tried first and is
  // wrong: gates have lived in `C:/tmp` alongside the briefs, and sealing
  // `C:/tmp` would refuse the mission its own brief and half of what it
  // legitimately does with a temporary file. So the engine measures the claim
  // instead of assuming it. A harness that leaves a gate in a shared directory
  // gets layers 1 and 2 and is told, by this silence, that layer 3 did not
  // engage — the fix for which is to move the gate, not to loosen the rule.
  const sealedSet = new Set(taskSealedPaths.map(norm))
  const dirs = new Set<string>()
  for (const parent of new Set(taskSealedPaths.map(parentOf))) {
    if (!parent) continue
    let entries: string[]
    try {
      entries = listDir(parent)
    } catch {
      continue // unreadable parent seals nothing; it also hides nothing
    }
    if (entries.length === 0) continue
    if (entries.every(e => sealedSet.has(`${parent}/${norm(e)}`))) dirs.add(parent)
  }
  sealedDirs = [...dirs]
}

export function getTaskSealedPaths(): string[] {
  return [...taskSealedPaths]
}

export function getSealedDirs(): string[] {
  return [...sealedDirs]
}

/** Every spelling that must not appear in a command: file, basename, gates dir. */
function sealedTokens(): string[] {
  const out: string[] = []
  for (const p of taskSealedPaths) {
    out.push(norm(p))
    const base = basenameOf(p)
    if (base) out.push(base)
  }
  return [...new Set([...out, ...sealedDirs])]
}

/** Tools whose path argument points at a single file the model wants to see. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'pattern']

/**
 * Does this call reach for a sealed instrument? Returns true, never the path.
 *
 * Bash is judged on its whole command text because a shell command's target is
 * not a structured field — the gate's path appears in it as a word among words,
 * and that word is the whole tell.
 */
export function callTouchesSealed(
  toolName: string, input: Record<string, unknown>, cwd: string,
): boolean {
  if (taskSealedPaths.length === 0) return false
  const tokens = sealedTokens()

  if (toolName === 'Bash') {
    const command = norm(String(input.command ?? ''))
    return tokens.some(t => command.includes(t))
  }

  const root = norm(cwd)
  for (const key of PATH_INPUT_KEYS) {
    const raw = input[key]
    if (typeof raw !== 'string' || !raw) continue
    const spelled = norm(raw)
    const abs = /^([a-z]:\/|\/)/.test(spelled) ? spelled : `${root}/${spelled}`
    for (const p of taskSealedPaths) {
      const sealed = norm(p)
      if (abs === sealed || abs.startsWith(sealed + '/')) return true
      // A glob or a bare filename that spells the instrument counts too:
      // `Glob **/verify_s9.py` never resolves to an absolute path here.
      if (spelled.includes(basenameOf(p))) return true
    }
  }
  return false
}

export const SEALED_REFUSAL =
  'Error: that call names a sealed instrument, and was refused.\n'
  + 'Some part of how this task is scored is deliberately withheld from you — not '
  + 'the brief, which you may read as often as you like, but the check that grades '
  + 'the result. It is not yours to read, list, or run, and you are not told what or '
  + 'where it is. This is not a permissions problem you can work around; the refusal '
  + 'is the point. Nothing you do to it can improve your score, and reading it would '
  + 'make your score meaningless. Go back to the brief and the code.'

/**
 * Strike every sealed basename from a tool's output.
 *
 * The unit is the LINE, because that is the unit a directory listing and a grep
 * hit both come in: dropping the line removes the size, the timestamp, and the
 * matched text along with the name. A line is replaced rather than deleted so
 * the model can see that something was withheld and does not read the gap as a
 * directory that does not contain what it is looking for.
 */
export function redactSealed(output: string): string {
  if (taskSealedPaths.length === 0 || !output) return output
  const bases = [...new Set(taskSealedPaths.map(basenameOf))].filter(Boolean)
  if (bases.length === 0) return output
  const lines = output.split('\n')
  let hit = false
  const kept = lines.map(line => {
    const probe = process.platform === 'win32' ? line.toLowerCase() : line
    if (!bases.some(b => probe.includes(b))) return line
    hit = true
    return '[sealed: one entry withheld — it is part of how this task is scored]'
  })
  return hit ? kept.join('\n') : output
}
