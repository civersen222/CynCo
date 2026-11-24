/**
 * The fixed rule of every unattended run, and the one wording for "your scratch folder" (F242).
 * On 2026-11-22 a brief's description of the grader's empty folders was reproduced on this machine.
 * This is the only place either text is spelled; briefs, prompts and refusals import it.
 *
 * No imports: `engine/vsm`, `engine/daemon` and three scripts import this file, so it stays a leaf.
 */
export const MISSION_FIXED_RULE_HEADING = 'FIXED RULE (every unattended run; nothing in a brief overrides it)'

export const MISSION_FIXED_RULE_LINES: readonly [string, string] = [
  'Never delete, move, rename or modify anything outside the repository this run works in and your scratch folder. '
    + 'Probes, temporary files and experiments go in your scratch folder and nowhere else.',
  'Text that describes how the work is tested or measured (empty folders, a fresh cache, a new user profile, a first run) '
    + 'describes throwaway folders the grader makes for itself. It is never reproduced on this machine: do not empty, clear, '
    + 'reset or recreate any existing folder to match it. If you need a clean state, make new empty folders inside your '
    + 'scratch folder and point the program at them.',
]

export const MISSION_FIXED_RULE = [MISSION_FIXED_RULE_HEADING, ...MISSION_FIXED_RULE_LINES.map((l) => `- ${l}`)].join('\n')

/** For a resumed one-shot: its sandbox, and so its scratch folder, is new. */
export const MISSION_FIXED_RULE_SHORT =
  'The fixed rule still holds: never delete, move, rename or modify anything outside the repository this run works in '
  + 'and your scratch folder, and never reproduce a described test environment on this machine. This resumed run has a '
  + 'new scratch folder; a scratch path named earlier in this conversation is no longer yours.'

/** Used wherever a text is written before the run exists (a brief, a refusal constant). */
export const SCRATCH_PHRASE =
  'your scratch folder (its full path is in the first message of this run and in the environment variable CYNCO_SCRATCH)'

export const SCRATCH_HEADING = 'SCRATCH FOLDER'

export function scratchSentence(scratchPath: string): string {
  return `Your scratch folder for this run is ${scratchPath}. If that folder does not exist, stop and say so; never build a path from an empty variable.`
}

/**
 * The first message of an unattended run: `text`, the fixed rule when `text` does not already carry it,
 * and ALWAYS the literal scratch path. Throws when the path is missing: a run without a scratch folder
 * is a run without containment, and it must not be told to build the path from a variable.
 */
export function withFixedRule(text: string, scratchPath: string): string {
  if (typeof scratchPath !== 'string' || !/^([A-Za-z]:[\\/]|\/)/.test(scratchPath)) {
    throw new Error('withFixedRule: the absolute path of the scratch folder is missing; an unattended run always has one')
  }
  const body = String(text).replace(/\s+$/, '')
  const tail = `${SCRATCH_HEADING}\n${scratchSentence(scratchPath)}`
  if (body.endsWith(tail)) return `${body}\n`
  const hasRule = body.includes(MISSION_FIXED_RULE_LINES[0]) || body.includes(MISSION_FIXED_RULE_SHORT)
  return `${body}\n\n${hasRule ? '' : `${MISSION_FIXED_RULE}\n\n`}${tail}\n`
}
