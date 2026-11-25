/**
 * The fixed rule of every unattended run and the one wording for its scratch folder (F242,
 * `engine/missionRule.ts`). On 2026-11-22 a brief's description of the grader's empty folders was
 * reproduced on this machine; every brief and every first message now carries the rule, and the
 * first message carries the literal path of the run's scratch folder.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MISSION_FIXED_RULE, MISSION_FIXED_RULE_HEADING, MISSION_FIXED_RULE_LINES, MISSION_FIXED_RULE_SHORT,
  SCRATCH_HEADING, SCRATCH_PHRASE, scratchSentence, withFixedRule,
} from '../missionRule.js'
import { MissionInvariants } from '../vsm/missionInvariants.js'
import { DOWNLOAD_REFUSAL } from '../tools/approvalGate.js'
import { testContainment, toolEnv } from '../containment.js'

const SEALED = /heldout|gate_c\d|perturb_/i
const TMP = /C:(\\+|\/)tmp/i
const MISSING = 'withFixedRule: the absolute path of the scratch folder is missing; an unattended run always has one'
const count = (text: string, part: string) => text.split(part).length - 1

describe('the fixed rule (F242)', () => {
  const texts: Array<[string, string]> = [
    ['MISSION_FIXED_RULE', MISSION_FIXED_RULE],
    ['line 1', MISSION_FIXED_RULE_LINES[0]],
    ['line 2', MISSION_FIXED_RULE_LINES[1]],
    ['MISSION_FIXED_RULE_SHORT', MISSION_FIXED_RULE_SHORT],
    ['SCRATCH_PHRASE', SCRATCH_PHRASE],
    ['scratchSentence', scratchSentence('C:/x')],
  ]

  it('names no sealed instrument and no C:\\tmp, in any of its texts', () => {
    for (const [name, text] of texts) {
      expect(text, name).not.toMatch(SEALED)
      expect(text, name).not.toMatch(TMP)
    }
  })

  it('names the variable once, as a place to read the path, never as a path prefix', () => {
    for (const [name, text] of texts) {
      expect(text, name).not.toMatch(/\$env:CYNCO_SCRATCH|\$CYNCO_SCRATCH|%CYNCO_SCRATCH%/)
    }
    expect(count(SCRATCH_PHRASE, 'CYNCO_SCRATCH')).toBe(1)
    expect(MISSION_FIXED_RULE).toBe(`${MISSION_FIXED_RULE_HEADING}\n- ${MISSION_FIXED_RULE_LINES[0]}\n- ${MISSION_FIXED_RULE_LINES[1]}`)
  })

  it('withFixedRule keeps the text first, adds the rule once and ends with the scratch sentence', () => {
    const out = withFixedRule('do the work', 'C:/s/run/scratch')
    expect(out.startsWith('do the work\n')).toBe(true)
    expect(out.trimEnd().endsWith(scratchSentence('C:/s/run/scratch'))).toBe(true)
    expect(out.endsWith('\n')).toBe(true)
    expect(count(out, MISSION_FIXED_RULE_HEADING)).toBe(1)
    expect(count(out, MISSION_FIXED_RULE_LINES[0])).toBe(1)
    expect(count(out, MISSION_FIXED_RULE_LINES[1])).toBe(1)
    expect(count(out, SCRATCH_HEADING)).toBe(1)
  })

  it('a text that already holds the rule gains only the scratch block', () => {
    const brief = `RULES\n- ${MISSION_FIXED_RULE_LINES[0]}\n- ${MISSION_FIXED_RULE_LINES[1]}\n\nDONE WHEN\nmarker`
    const out = withFixedRule(brief, 'C:/s/run/scratch')
    expect(out).toBe(`${brief}\n\n${SCRATCH_HEADING}\n${scratchSentence('C:/s/run/scratch')}\n`)
    expect(out).not.toContain(MISSION_FIXED_RULE_HEADING)
  })

  it('a text that holds the short form gains only the scratch block', () => {
    const resume = `Continue from the last tool result. ${MISSION_FIXED_RULE_SHORT}`
    const out = withFixedRule(resume, '/sandbox/run/scratch')
    expect(out).toBe(`${resume}\n\n${SCRATCH_HEADING}\n${scratchSentence('/sandbox/run/scratch')}\n`)
  })

  it('applying it twice with the same path is applying it once', () => {
    const once = withFixedRule('do the work', 'C:\\s\\run\\scratch')
    expect(withFixedRule(once, 'C:\\s\\run\\scratch')).toBe(once)
  })

  it('refuses a missing or relative scratch path, with the one message', () => {
    expect(() => withFixedRule('x', '')).toThrow(MISSING)
    expect(() => withFixedRule('x', undefined as unknown as string)).toThrow(MISSING)
    expect(() => withFixedRule('x', 'scratch')).toThrow(MISSING)
    try {
      withFixedRule('x', '')
    } catch (e) {
      expect((e as Error).message).toBe(MISSING)
    }
  })

  it('the revert refusal and the download refusal send the model to its scratch folder and the brief, never to C:\\tmp or a home spelling', () => {
    const inv = new MissionInvariants({ editGapCap: 5, commitGapCap: 8, revertBan: true, codeIndexFirst: true })
    const v = inv.evaluate('Bash', { command: 'git checkout -- app.py' })
    expect(v.kind).toBe('deny')
    if (v.kind !== 'deny') return
    expect(v.invariant).toBe('revert')
    expect(v.message).toContain(SCRATCH_PHRASE)
    expect(v.message).not.toMatch(/tmp/i)
    expect(DOWNLOAD_REFUSAL).toContain('the brief names the folder by its full path')
    expect(DOWNLOAD_REFUSAL).not.toContain('~')
  })

  it('a contained tool child is given CYNCO_SCRATCH, the context\'s scratch folder', () => {
    // testContainment touches no disk: these folders are names only. That the folder exists in a
    // real contained shell is the Bun fixture's case (containmentLauncher.test.ts, scratchThroughTheTool).
    const dir = join(tmpdir(), 'cynco-missionrule-never-created')
    const sandbox = { root: join(dir, 'run'), home: join(dir, 'run', 'home'), tmp: join(dir, 'run', 'tmp'), scratch: join(dir, 'run', 'scratch') }
    const ctx = testContainment({
      missionCwd: join(dir, 'mission'), sandbox, home: join(dir, 'home'),
      folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
    })
    const env = toolEnv({}, ctx)
    expect(env.CYNCO_SCRATCH).toBe(ctx.sandbox.scratch)
    expect(env.CYNCO_SCRATCH).toBeTruthy()
  })
})
