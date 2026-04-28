/**
 * Tests for systemPromptText module — all exported constants and assembleBasePrompt().
 */
import { describe, expect, it } from 'bun:test'
import {
  ROLE,
  TOOL_USE,
  WORKFLOW,
  EFFICIENCY,
  CODE_QUALITY,
  VERSION_CONTROL,
  PLANS,
  VSM_GOVERNANCE,
  MEMORY,
  LEARNINGS_HEADER,
  FIRST_TIME_PROJECT,
  FRESH_PROJECT,
  assembleBasePrompt,
} from '../../engine/systemPromptText.js'

// ─── Task 1: ROLE ──────

describe('ROLE', () => {
  it('exports a non-empty string (length > 100)', () => {
    expect(typeof ROLE).toBe('string')
    expect(ROLE.length).toBeGreaterThan(100)
  })

  it('contains "CynCo"', () => {
    expect(ROLE).toContain("CynCo")
  })

  it('contains "coding assistant"', () => {
    expect(ROLE.toLowerCase()).toContain('coding assistant')
  })

  it('contains "local"', () => {
    expect(ROLE.toLowerCase()).toContain('local')
  })

  it('contains "tool"', () => {
    expect(ROLE.toLowerCase()).toContain('tool')
  })
})

// ─── Task 2: TOOL_USE ──────

describe('TOOL_USE', () => {
  it('exports a non-empty string (length > 100)', () => {
    expect(typeof TOOL_USE).toBe('string')
    expect(TOOL_USE.length).toBeGreaterThan(100)
  })

  it('contains "Read" and "Edit"', () => {
    expect(TOOL_USE).toContain('Read')
    expect(TOOL_USE).toContain('Edit')
  })

  it('contains "Grep"', () => {
    expect(TOOL_USE).toContain('Grep')
  })

  it('matches /do NOT|don\'t|never/i', () => {
    expect(TOOL_USE).toMatch(/do NOT|don't|never/i)
  })
})

// ─── Task 3: WORKFLOW ──────

describe('WORKFLOW', () => {
  it('exports a non-empty string (length > 100)', () => {
    expect(typeof WORKFLOW).toBe('string')
    expect(WORKFLOW.length).toBeGreaterThan(100)
  })

  it('EXPLORE appears before ANALYZE, ANALYZE before IMPLEMENT, IMPLEMENT before VERIFY', () => {
    const exploreIdx = WORKFLOW.indexOf('EXPLORE')
    const analyzeIdx = WORKFLOW.indexOf('ANALYZE')
    const implementIdx = WORKFLOW.indexOf('IMPLEMENT')
    const verifyIdx = WORKFLOW.indexOf('VERIFY')

    expect(exploreIdx).toBeGreaterThan(-1)
    expect(analyzeIdx).toBeGreaterThan(-1)
    expect(implementIdx).toBeGreaterThan(-1)
    expect(verifyIdx).toBeGreaterThan(-1)

    expect(exploreIdx).toBeLessThan(analyzeIdx)
    expect(analyzeIdx).toBeLessThan(implementIdx)
    expect(implementIdx).toBeLessThan(verifyIdx)
  })

  it('contains "read"', () => {
    expect(WORKFLOW.toLowerCase()).toContain('read')
  })
})

// ─── Task 4: EFFICIENCY ──────

describe('EFFICIENCY', () => {
  it('exports a non-empty string (length > 50)', () => {
    expect(typeof EFFICIENCY).toBe('string')
    expect(EFFICIENCY.length).toBeGreaterThan(50)
  })

  it('matches /context/i', () => {
    expect(EFFICIENCY).toMatch(/context/i)
  })

  it('matches /combine|batch|single/i', () => {
    expect(EFFICIENCY).toMatch(/combine|batch|single/i)
  })
})

// ─── Task 5: VSM_GOVERNANCE ──────

describe('VSM_GOVERNANCE', () => {
  it('exports a non-empty string (length > 200)', () => {
    expect(typeof VSM_GOVERNANCE).toBe('string')
    expect(VSM_GOVERNANCE.length).toBeGreaterThan(200)
  })

  it('contains "Viable System Model"', () => {
    expect(VSM_GOVERNANCE).toContain('Viable System Model')
  })

  it('contains all signal names: VARIETY, STABILITY, CONTEXT PRESSURE, PERFORMANCE, DRIFT, STUCK', () => {
    expect(VSM_GOVERNANCE).toContain('VARIETY')
    expect(VSM_GOVERNANCE).toContain('STABILITY')
    expect(VSM_GOVERNANCE).toContain('CONTEXT PRESSURE')
    expect(VSM_GOVERNANCE).toContain('PERFORMANCE')
    expect(VSM_GOVERNANCE).toContain('DRIFT')
    expect(VSM_GOVERNANCE).toContain('STUCK')
  })

  it('contains heterarchy modes: CRISIS, EXPLORATION, RECOVERY', () => {
    expect(VSM_GOVERNANCE).toContain('CRISIS')
    expect(VSM_GOVERNANCE).toContain('EXPLORATION')
    expect(VSM_GOVERNANCE).toContain('RECOVERY')
  })

  it('contains S3, S4, S5', () => {
    expect(VSM_GOVERNANCE).toContain('S3')
    expect(VSM_GOVERNANCE).toContain('S4')
    expect(VSM_GOVERNANCE).toContain('S5')
  })
})

// ─── VERSION_CONTROL and PLANS ──────

describe('VERSION_CONTROL', () => {
  it('exports a non-empty string', () => {
    expect(typeof VERSION_CONTROL).toBe('string')
    expect(VERSION_CONTROL.length).toBeGreaterThan(50)
  })

  it('mentions git diff', () => {
    expect(VERSION_CONTROL).toContain('git diff')
  })
})

describe('PLANS', () => {
  it('exports a non-empty string', () => {
    expect(typeof PLANS).toBe('string')
    expect(PLANS.length).toBeGreaterThan(50)
  })

  it('instructs to save plans to files', () => {
    expect(PLANS).toContain('save')
    expect(PLANS).toContain('file')
  })
})

// ─── Task 6: CODE_QUALITY and MEMORY ──────

describe('CODE_QUALITY', () => {
  it('exports a non-empty string (length > 50)', () => {
    expect(typeof CODE_QUALITY).toBe('string')
    expect(CODE_QUALITY.length).toBeGreaterThan(50)
  })

  it('matches /minimal/i', () => {
    expect(CODE_QUALITY).toMatch(/minimal/i)
  })
})

describe('MEMORY', () => {
  it('exports a non-empty string (length > 50)', () => {
    expect(typeof MEMORY).toBe('string')
    expect(MEMORY.length).toBeGreaterThan(50)
  })

  it('contains "SaveLearning"', () => {
    expect(MEMORY).toContain('SaveLearning')
  })

  it('matches /session/i', () => {
    expect(MEMORY).toMatch(/session/i)
  })
})

// ─── Task 7: assembleBasePrompt() ──────

describe('assembleBasePrompt', () => {
  const toolNames = 'Read, Edit, Bash, Grep, Glob'
  const cwd = '/home/user/project'
  const result = assembleBasePrompt(toolNames, cwd)

  it('returns an array of strings', () => {
    expect(Array.isArray(result)).toBe(true)
    for (const item of result) {
      expect(typeof item).toBe('string')
    }
  })

  it('includes the working directory in joined output', () => {
    const joined = result.join('\n')
    expect(joined).toContain(cwd)
  })

  it('includes the tool list in joined output', () => {
    const joined = result.join('\n')
    expect(joined).toContain(toolNames)
  })

  it('includes all major section tags', () => {
    const joined = result.join('\n')
    expect(joined).toContain('ROLE')
    expect(joined).toContain('TOOL_USE')
    expect(joined).toContain('PROBLEM_SOLVING_WORKFLOW')
    expect(joined).toContain('EFFICIENCY')
    expect(joined).toContain('VSM_GOVERNANCE')
    expect(joined).toContain('CODE_QUALITY')
    expect(joined).toContain('VERSION_CONTROL')
    expect(joined).toContain('PLANS')
    expect(joined).toContain('MEMORY')
  })

  it('ROLE is first (result[0] contains "CynCo")', () => {
    expect(result[0]).toContain("CynCo")
  })
})

// ─── Task 8: Dynamic section framing text ──────

describe('LEARNINGS_HEADER', () => {
  it('is a non-empty string containing "Learnings"', () => {
    expect(typeof LEARNINGS_HEADER).toBe('string')
    expect(LEARNINGS_HEADER.length).toBeGreaterThan(0)
    expect(LEARNINGS_HEADER).toContain('Learnings')
  })
})

describe('FIRST_TIME_PROJECT', () => {
  it('contains "FIRST TIME", "Glob", "SaveLearning"', () => {
    expect(FIRST_TIME_PROJECT).toContain('FIRST TIME')
    expect(FIRST_TIME_PROJECT).toContain('Glob')
    expect(FIRST_TIME_PROJECT).toContain('SaveLearning')
  })
})

describe('FRESH_PROJECT', () => {
  it('contains "empty"', () => {
    expect(FRESH_PROJECT).toContain('empty')
  })
})
