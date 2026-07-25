import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadTrajectories,
  buildDatasets,
  summarizeCorpus,
  exportDatasets,
  toChatML,
  isUsable,
  evaluateReadiness,
  GATE_MIN_USABLE,
  GATE_MIN_NEGATIVE,
  GATE_MAX_AVG_REWARD,
} from '../../training/datasetBuilder.js'

let root: string
let trajDir: string
let rewDir: string
let outDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsb-'))
  trajDir = join(root, 'trajectories')
  rewDir = join(root, 'rewards')
  outDir = join(root, 'datasets')
  mkdirSync(trajDir, { recursive: true })
  mkdirSync(rewDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function turnLine(taskId: string, idx: number, model: string) {
  return JSON.stringify({
    task_id: taskId,
    turn_idx: idx,
    ts: '2026-07-25T00:00:00.000Z',
    model,
    tool_calls: [{ name: 'Edit', inputHash: 'abc123def456', success: true, latencyMs: 12 }],
    state_features: {
      filesTouched: 1, diffSize: 4, testsTotal: 10,
      testsFailing: 0, toolsUsed: ['Edit'], contextPct: 0,
    },
    reward_components: { toolSuccessRate: 1, stuckTurns: 0, varietyEntropy: 0 },
  })
}

type SeedOpts = {
  taskId: string
  reward: number
  labelerVersion?: number
  snapshot?: boolean
  degenerate?: boolean
  model?: string
  userText?: string
}

function seed(o: SeedOpts) {
  const model = o.model ?? 'qwen3.6'
  writeFileSync(join(trajDir, `${o.taskId}.jsonl`), turnLine(o.taskId, 0, model) + '\n')

  const rec: Record<string, unknown> = {
    taskId: o.taskId,
    turns: 1,
    components: { testsPass: 0.8, typecheckPass: 'unknown' },
    reward: o.reward,
  }
  if (o.labelerVersion !== undefined) rec.labelerVersion = o.labelerVersion
  if (o.degenerate) rec.degenerate = true
  writeFileSync(join(rewDir, `${o.taskId}.reward.json`), JSON.stringify(rec))

  if (o.snapshot) {
    writeFileSync(join(trajDir, `${o.taskId}.messages.json`), JSON.stringify({
      schemaVersion: 2,
      taskId: o.taskId,
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: o.userText ?? 'Fix the failing realm test' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file first.' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export const a = 1' }] },
      ],
    }))
  }
}

describe('loadTrajectories — snapshots', () => {
  it('attaches the snapshot when one exists', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2, snapshot: true })
    const [t] = loadTrajectories(trajDir, rewDir)
    expect(t.hasSnapshot).toBe(true)
    expect(t.snapshot!.messages).toHaveLength(3)
  })

  it('reports hasSnapshot without parsing when loadSnapshots is false', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2, snapshot: true })
    const [t] = loadTrajectories(trajDir, rewDir, { loadSnapshots: false })
    expect(t.hasSnapshot).toBe(true)
    expect(t.snapshot).toBeNull()
  })

  it('leaves hasSnapshot false when there is no snapshot', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2 })
    const [t] = loadTrajectories(trajDir, rewDir)
    expect(t.hasSnapshot).toBe(false)
    expect(t.snapshot).toBeNull()
  })
})

describe('isUsable — eligibility', () => {
  it('excludes a legacy v1 reward file even with a snapshot', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('excludes a v2 reward with no snapshot', () => {
    seed({ taskId: 'nosnap', reward: 0.9, labelerVersion: 2 })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('excludes a degenerate record', () => {
    seed({ taskId: 'degen', reward: 0.0, labelerVersion: 2, snapshot: true, degenerate: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('accepts a v2 reward with a snapshot', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(true)
  })
})

describe('toChatML', () => {
  it('renders tool calls and results as tagged text', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'contents' }] },
    ])
    expect(out).toHaveLength(3)
    expect(out[1].content).toContain('<tool name="Read">')
    expect(out[1].content).toContain('a.ts')
    expect(out[2].content).toBe('<tool_result>contents</tool_result>')
  })

  it('drops messages that render to nothing', () => {
    expect(toChatML([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('marks an errored tool result', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] },
    ])
    expect(out[0].content).toContain('error="true"')
  })
})

describe('buildDatasets — SFT', () => {
  it('emits the real conversation, never a synthesized tool sequence', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true, userText: 'Fix the realm test' })
    const { sft } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(sft).toHaveLength(1)
    const parsed = JSON.parse(sft[0])
    expect(parsed.messages[0]).toEqual({ role: 'user', content: 'Fix the realm test' })
    expect(sft[0]).not.toContain('Tool sequence')
  })

  it('excludes legacy and snapshot-less rows from SFT', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    seed({ taskId: 'nosnap', reward: 0.9, labelerVersion: 2 })
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    const { sft } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(sft).toHaveLength(1)
  })
})

describe('buildDatasets — DPO keeps the negatives', () => {
  it('pairs a high-reward run against a low-reward run of the same model', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, userText: 'good run' })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true, userText: 'bad run' })
    const { dpo } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(dpo).toHaveLength(1)
    const pair = JSON.parse(dpo[0])
    expect(pair.chosen[0].content).toBe('good run')
    expect(pair.rejected[0].content).toBe('bad run')
  })

  it('does not pair across models', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, model: 'a' })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true, model: 'b' })
    expect(buildDatasets(loadTrajectories(trajDir, rewDir)).dpo).toHaveLength(0)
  })
})

describe('summarizeCorpus', () => {
  it('counts usable, negative and legacy separately', () => {
    seed({ taskId: 'legacy1', reward: 1.0, snapshot: true })
    seed({ taskId: 'legacy2', reward: 1.0, snapshot: true })
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true })
    const stats = summarizeCorpus(loadTrajectories(trajDir, rewDir, { loadSnapshots: false }))
    expect(stats.totalTasks).toBe(4)
    expect(stats.usableExamples).toBe(2)
    expect(stats.negativeExamples).toBe(1)
    expect(stats.legacyExcluded).toBe(2)
    expect(stats.avgReward).toBeCloseTo(0.485, 3)
  })

  it('averages only usable rows, so the 147 saturated legacy rows cannot hide a regression', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    seed({ taskId: 'lose', reward: 0.1, labelerVersion: 2, snapshot: true })
    expect(summarizeCorpus(loadTrajectories(trajDir, rewDir)).avgReward).toBeCloseTo(0.1, 6)
  })
})

describe('exportDatasets', () => {
  it('always rewrites sft.jsonl so a stale corpus cannot linger', () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'sft.jsonl'), '{"messages":[]}\n')
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    const stats = exportDatasets(outDir, trajDir, rewDir)
    expect(stats.sftExamples).toBe(0)
    expect(readFileSync(join(outDir, 'sft.jsonl'), 'utf-8')).toBe('')
  })

  it('writes stats.json with the new fields', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    exportDatasets(outDir, trajDir, rewDir)
    const stats = JSON.parse(readFileSync(join(outDir, 'stats.json'), 'utf-8'))
    expect(stats.usableExamples).toBe(1)
    expect(stats.negativeExamples).toBe(0)
    expect(stats.legacyExcluded).toBe(0)
    expect(existsSync(join(outDir, 'sft.jsonl'))).toBe(true)
  })
})

describe('toChatML — malformed snapshots off disk', () => {
  it('keeps an image-only message rather than deleting the turn', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I see a red square.' }] },
    ] as never)
    // Dropping the image turn would train the assistant to answer a phantom.
    expect(out).toHaveLength(2)
    expect(out[0].content).toBe('[image block omitted]')
  })

  it('drops a message holding only redacted thinking', () => {
    expect(toChatML([{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'z' }] }] as never)).toEqual([])
  })

  it('renders a non-string non-array tool_result as empty, not [object Object]', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: { oops: 1 } }] },
    ] as never)
    expect(out[0].content).toBe('<tool_result></tool_result>')
  })

  it('survives a null message and a bare-string content', () => {
    const out = toChatML([null, { role: 'user', content: 'plain text' }, { role: 'user' }] as never)
    expect(out).toEqual([{ role: 'user', content: 'plain text' }])
  })
})

describe('buildDPODataset — model attribution', () => {
  it('excludes a run whose model was never recorded, rather than bucketing it', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, model: '' })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true, model: '' })
    expect(buildDatasets(loadTrajectories(trajDir, rewDir)).dpo).toHaveLength(0)
  })

  it('pairs round-robin, not as a cross product', () => {
    seed({ taskId: 'w1', reward: 0.85, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'w2', reward: 0.9, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'w3', reward: 0.95, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'l1', reward: 0.12, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'l2', reward: 0.05, labelerVersion: 2, snapshot: true })
    // Cross product would be 6. Round-robin is max(3, 2) = 3.
    expect(buildDatasets(loadTrajectories(trajDir, rewDir)).dpo).toHaveLength(3)
  })
})

describe('summarizeCorpus — the negative boundary', () => {
  it('counts a reward of exactly the DPO ceiling as negative, since it can be paired', () => {
    seed({ taskId: 'edge', reward: 0.3, labelerVersion: 2, snapshot: true })
    expect(summarizeCorpus(loadTrajectories(trajDir, rewDir)).negativeExamples).toBe(1)
  })
})

describe('evaluateReadiness', () => {
  const base = {
    totalTasks: 0, tasksWithRewards: 0, legacyExcluded: 0, rewardDistribution: [],
  }

  it('passes when all three conditions hold', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 150, negativeExamples: 20, pairableNegatives: 20, avgReward: 0.62 })
    expect(r.ready).toBe(true)
    expect(r.conditions.every(c => c.ok)).toBe(true)
  })

  it('fails on volume alone', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 149, negativeExamples: 20, pairableNegatives: 20, avgReward: 0.62 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'usable examples')!.ok).toBe(false)
  })

  it('fails without negatives, because DPO needs pairs', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 400, negativeExamples: 19, pairableNegatives: 19, avgReward: 0.62 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'pairable negatives')!.ok).toBe(false)
  })

  it('fails on a saturated mean — the 147-rows-all-1.0 regression', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 400, negativeExamples: 40, pairableNegatives: 40, avgReward: 0.95 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'avg reward')!.ok).toBe(false)
  })

  it('reports every condition, passing or not', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 0, negativeExamples: 0, pairableNegatives: 0, avgReward: 0 })
    expect(r.conditions).toHaveLength(3)
    expect(r.conditions.map(c => c.name)).toEqual(['usable examples', 'pairable negatives', 'avg reward'])
  })

  it('exposes its thresholds as constants rather than burying them', () => {
    expect(GATE_MIN_USABLE).toBe(150)
    expect(GATE_MIN_NEGATIVE).toBe(20)
    expect(GATE_MAX_AVG_REWARD).toBe(0.9)
  })

  it('never reports a mean it did not measure', () => {
    // avgReward is 0 for an empty corpus, and 0 < 0.9. Reporting that as PASS
    // would claim a measurement that was never taken.
    const r = evaluateReadiness({ ...base, usableExamples: 0, negativeExamples: 0, pairableNegatives: 0, avgReward: 0 })
    const avg = r.conditions.find(c => c.name === 'avg reward')!
    expect(avg.ok).toBe(false)
    expect(avg.actual).toBeNull()
    expect(avg.display).toBe('not measured')
    expect(avg.reason).toMatch(/no usable examples/i)
  })

  it('names each failure in the real numbers it was given', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 100, negativeExamples: 3, pairableNegatives: 3, avgReward: 0.94 })
    const [usable, neg, avg] = r.conditions
    expect(usable.reason).toContain('100')
    expect(usable.reason).toContain('50') // shortfall
    expect(neg.reason).toContain('3')
    expect(neg.reason).toContain('17') // shortfall
    expect(avg.reason).toContain('0.940')
    expect(r.reasons).toHaveLength(3)
  })

  it('gives no reasons when it is ready', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 200, negativeExamples: 30, pairableNegatives: 30, avgReward: 0.5 })
    expect(r.reasons).toEqual([])
    expect(r.conditions.every(c => c.reason === undefined)).toBe(true)
  })
})

describe('summarizeCorpus — pairableNegatives vs negativeExamples', () => {
  it('counts an unattributed negative as negative but not as pairable', () => {
    // It exports zero DPO pairs, so gating on the raw count would pass a
    // corpus that trains nothing.
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'orphan', reward: 0.1, labelerVersion: 2, snapshot: true, model: '' })
    const s = summarizeCorpus(loadTrajectories(trajDir, rewDir))
    expect(s.negativeExamples).toBe(1)
    expect(s.pairableNegatives).toBe(0)
  })

  it('does not count a negative with no chosen counterpart under its model', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, model: 'a' })
    seed({ taskId: 'lonely', reward: 0.1, labelerVersion: 2, snapshot: true, model: 'b' })
    const s = summarizeCorpus(loadTrajectories(trajDir, rewDir))
    expect(s.negativeExamples).toBe(1)
    expect(s.pairableNegatives).toBe(0)
  })

  it('counts one that can pair', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, model: 'a' })
    seed({ taskId: 'lose', reward: 0.1, labelerVersion: 2, snapshot: true, model: 'a' })
    expect(summarizeCorpus(loadTrajectories(trajDir, rewDir)).pairableNegatives).toBe(1)
  })
})
