import { describe, expect, it, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TrajectoryRecorder,
  getTrajectoryRecorder,
  initTrajectoryRecorder,
} from '../../training/trajectoryRecorder.js'
import type { TurnRecord } from '../../training/trajectoryRecorder.js'
import type { Message } from '../../types.js'

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    toolCalls: [
      { name: 'Read', inputHash: 'abc123', success: true, latencyMs: 45 },
      { name: 'Edit', inputHash: 'def456', success: true, latencyMs: 120 },
    ],
    stateFeatures: {
      filesTouched: 2,
      diffSize: 80,
      testsTotal: 10,
      testsFailing: 0,
      toolsUsed: ['Read', 'Edit'],
      contextPct: 0.35,
    },
    rewardComponents: {
      toolSuccessRate: 1.0,
      stuckTurns: 0,
      varietyEntropy: 0.69,
    },
    ...overrides,
  }
}

describe('TrajectoryRecorder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'traj-test-'))
  })

  it('records a turn and writes a valid JSONL file', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-001', 'qwen3:8b')
    recorder.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'task-001.jsonl')
    const raw = readFileSync(filePath, 'utf-8').trim()
    const lines = raw.split('\n').filter(Boolean)

    expect(lines).toHaveLength(1)

    const record = JSON.parse(lines[0])
    expect(record.task_id).toBe('task-001')
    expect(record.turn_idx).toBe(0)
    expect(record.model).toBe('qwen3:8b')
    expect(record.adapter_id).toBeUndefined()
    expect(typeof record.ts).toBe('string')
    expect(Array.isArray(record.tool_calls)).toBe(true)
    expect(record.tool_calls[0].name).toBe('Read')
    expect(record.state_features.filesTouched).toBe(2)
    expect(record.reward_components.toolSuccessRate).toBe(1.0)
  })

  it('increments turn_idx across multiple turns', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-002', 'gemma3:27b', 'lora-v1')
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'task-002.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)

    expect(lines).toHaveLength(3)

    const indices = lines.map(l => JSON.parse(l).turn_idx)
    expect(indices).toEqual([0, 1, 2])

    // adapter_id should be preserved
    expect(JSON.parse(lines[0]).adapter_id).toBe('lora-v1')
  })

  it('resets turn index when startTask is called again', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-003', 'qwen3:8b')
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())

    recorder.startTask('task-004', 'qwen3:8b')
    recorder.recordTurn(makeTurn())

    const file3 = join(tmpDir, 'task-003.jsonl')
    const file4 = join(tmpDir, 'task-004.jsonl')

    const lines3 = readFileSync(file3, 'utf-8').trim().split('\n').filter(Boolean)
    const lines4 = readFileSync(file4, 'utf-8').trim().split('\n').filter(Boolean)

    expect(lines3).toHaveLength(2)
    expect(lines4).toHaveLength(1)
    expect(JSON.parse(lines4[0]).turn_idx).toBe(0)
  })

  it('uses fsync (crash-safe write — no error = success)', () => {
    // If fsync throws on this platform the test would fail.
    // Passing confirms the fd lifecycle (open→append→fsync→close) works.
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-fsync', 'qwen3:8b')
    expect(() => recorder.recordTurn(makeTurn())).not.toThrow()
  })

  it('taskId getter returns current task id', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    expect(recorder.taskId).toBeNull()

    recorder.startTask('task-id-check', 'qwen3:8b')
    expect(recorder.taskId).toBe('task-id-check')
  })

  it('singleton: initTrajectoryRecorder sets instance returned by getTrajectoryRecorder', () => {
    const instance = initTrajectoryRecorder(tmpDir)
    expect(getTrajectoryRecorder()).toBe(instance)

    instance.startTask('singleton-task', 'qwen3:8b')
    instance.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'singleton-task.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('silently logs error and does not throw when recordTurn called before startTask', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    // No startTask — should not throw
    expect(() => recorder.recordTurn(makeTurn())).not.toThrow()
  })
})

// ─── endTask / message snapshot ───────────────────────────────────

describe('endTask', () => {
  it('writes a schemaVersion 2 snapshot with real message content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-snap-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-snap', 'qwen3.6:27b')
    const path = r.endTask([
      { role: 'user', content: [{ type: 'text', text: 'add a test for parseFoo' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will add it.' }] },
    ])

    expect(path).toBe(join(dir, 'task-snap.messages.json'))
    const snap = JSON.parse(readFileSync(path!, 'utf-8'))
    expect(snap.schemaVersion).toBe(2)
    expect(snap.taskId).toBe('task-snap')
    expect(snap.model).toBe('qwen3.6:27b')
    expect(typeof snap.startedAt).toBe('string')
    expect(typeof snap.endedAt).toBe('string')
    expect(snap.messages[0].content[0].text).toBe('add a test for parseFoo')
  })

  it('applies the sanitizer — a .env read is redacted in the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-redact-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-redact', 'm')
    const path = r.endTask([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/repo/.env' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'KEY=sk-secret' }] },
    ])
    expect(readFileSync(path!, 'utf-8')).not.toContain('sk-secret')
  })

  it('is a no-op when called twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-twice-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-twice', 'm')
    expect(r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).not.toBeNull()
    expect(r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBeNull()
  })

  it('writes no snapshot when the conversation is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-empty-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-empty', 'm')
    expect(r.endTask([])).toBeNull()
    expect(existsSync(join(dir, 'task-empty.messages.json'))).toBe(false)
  })

  it('clears the active task so a later recordTurn does not write into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-clear-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-clear', 'm')
    r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(r.taskId).toBeNull()
  })
})

// ─── The snapshot is the TASK, not the whole session ──────────────

describe('endTask — task boundary', () => {
  const msg = (role: 'user' | 'assistant' | 'system', text: string): Message =>
    ({ role, content: [{ type: 'text', text }] })

  function snapshotOf(dir: string, taskId: string) {
    return JSON.parse(readFileSync(join(dir, `${taskId}.messages.json`), 'utf-8'))
  }

  it('snapshots only the messages recorded after startTask', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-tail-'))
    const r = new TrajectoryRecorder(dir)
    const session = [msg('user', 'TASK ONE'), msg('assistant', 'done one')]
    r.startTask('task-tail', 'm', undefined, session.length)
    session.push(msg('user', 'TASK TWO'), msg('assistant', 'done two'))

    r.endTask(session)
    const snap = snapshotOf(dir, 'task-tail')
    const text = JSON.stringify(snap.messages)
    expect(text).toContain('TASK TWO')
    expect(text).not.toContain('TASK ONE')
    expect(snap.messages).toHaveLength(2)
  })

  it('keeps system messages that fall before the boundary', () => {
    // They were in the model's context for this task, so they are measured
    // context, and a ChatML row without its system prompt is a different
    // training example than the one that actually ran.
    const dir = mkdtempSync(join(tmpdir(), 'traj-sys-'))
    const r = new TrajectoryRecorder(dir)
    const session = [msg('system', 'SYSTEM CONTEXT'), msg('user', 'TASK ONE')]
    r.startTask('task-sys', 'm', undefined, session.length)
    session.push(msg('user', 'TASK TWO'))

    r.endTask(session)
    const snap = snapshotOf(dir, 'task-sys')
    expect(snap.messages[0].role).toBe('system')
    expect(JSON.stringify(snap.messages)).toContain('SYSTEM CONTEXT')
    expect(JSON.stringify(snap.messages)).not.toContain('TASK ONE')
  })

  it('two tasks in one session produce disjoint transcripts', () => {
    // A DPO pair built from two tasks of one session must not share an
    // identical prefix on both sides.
    const dir = mkdtempSync(join(tmpdir(), 'traj-disjoint-'))
    const r = new TrajectoryRecorder(dir)
    const session: Message[] = []

    r.startTask('t-a', 'm', undefined, session.length)
    session.push(msg('user', 'ALPHA'), msg('assistant', 'ok alpha'))
    r.endTask(session)

    r.startTask('t-b', 'm', undefined, session.length)
    session.push(msg('user', 'BRAVO'), msg('assistant', 'ok bravo'))
    r.endTask(session)

    const a = JSON.stringify(snapshotOf(dir, 't-a').messages)
    const b = JSON.stringify(snapshotOf(dir, 't-b').messages)
    expect(a).toContain('ALPHA')
    expect(a).not.toContain('BRAVO')
    expect(b).toContain('BRAVO')
    expect(b).not.toContain('ALPHA')
  })

  it('clamps to the whole array when compaction shrank it below the boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-clamp-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-clamp', 'm', undefined, 40)
    // compactNow replaced this.messages wholesale — the index points nowhere.
    const path = r.endTask([msg('user', 'COMPACTED SUMMARY'), msg('assistant', 'carry on')])

    expect(path).not.toBeNull()
    const snap = snapshotOf(dir, 'task-clamp')
    expect(snap.messages).toHaveLength(2)
    expect(JSON.stringify(snap.messages)).toContain('COMPACTED SUMMARY')
    // The boundary is reported as unenforced rather than silently assumed held.
    expect(snap.taskBoundary).toBe('clamped')
  })

  it('reports an enforced boundary as exact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-exact-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-exact', 'm', undefined, 1)
    r.endTask([msg('user', 'old'), msg('user', 'new')])
    expect(snapshotOf(dir, 'task-exact').taskBoundary).toBe('exact')
  })

  it('reports an unrecorded boundary as unmeasured and keeps everything', () => {
    // No index passed: the boundary was never measured. Keeping the whole
    // array is the honest fallback, and it says so rather than claiming exact.
    const dir = mkdtempSync(join(tmpdir(), 'traj-nobound-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-nobound', 'm')
    r.endTask([msg('user', 'a'), msg('user', 'b')])
    const snap = snapshotOf(dir, 'task-nobound')
    expect(snap.messages).toHaveLength(2)
    expect(snap.taskBoundary).toBe('unmeasured')
  })

  it('redacts a result the tail slice orphaned from its tool_use', () => {
    // Slicing can itself strip provenance: the tool_use falls before the
    // boundary, its result after. The sanitizer must fail closed on that, not
    // treat the unmatched id as "not sensitive" and cap it at 4 KB.
    const dir = mkdtempSync(join(tmpdir(), 'traj-slice-orphan-'))
    const r = new TrajectoryRecorder(dir)
    const session: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/repo/.env' } }] },
    ]
    r.startTask('task-slice-orphan', 'm', undefined, session.length)
    session.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'KEY=sk-leaked-value' }] })

    r.endTask(session)
    expect(readFileSync(join(dir, 'task-slice-orphan.messages.json'), 'utf-8')).not.toContain('sk-leaked-value')
  })

  it('does not carry a boundary from one task into the next', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-reset-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-r1', 'm', undefined, 2)
    r.endTask([msg('user', 'a'), msg('user', 'b'), msg('user', 'c')])
    r.startTask('task-r2', 'm')
    r.endTask([msg('user', 'a'), msg('user', 'b'), msg('user', 'c')])
    expect(snapshotOf(dir, 'task-r2').messages).toHaveLength(3)
  })
})

// ─── Unmeasured features are absent, not zero (2026-07-25) ────────

describe('recordTurn — unmeasured features', () => {
  it('omits the fields a caller did not measure instead of writing 0', () => {
    // An absent field is honest; a 0 is a claim. diffSize, contextPct and
    // varietyEntropy have no computation at the per-turn call site, so they
    // must not appear in the record at all.
    const dir = mkdtempSync(join(tmpdir(), 'traj-absent-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-absent', 'm')
    r.recordTurn({
      toolCalls: [{ name: 'Read', inputHash: 'a', success: true, latencyMs: 1 }],
      stateFeatures: { filesTouched: 0, testsTotal: 0, testsFailing: 0, toolsUsed: ['Read'] },
      rewardComponents: { toolSuccessRate: 1, stuckTurns: 2 },
    })

    const line = JSON.parse(readFileSync(join(dir, 'task-absent.jsonl'), 'utf-8').trim())
    expect('diffSize' in line.state_features).toBe(false)
    expect('contextPct' in line.state_features).toBe(false)
    expect('varietyEntropy' in line.reward_components).toBe(false)
    expect(line.reward_components.stuckTurns).toBe(2)
  })

  it('still persists them when a caller does measure them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-present-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-present', 'm')
    r.recordTurn(makeTurn())
    const line = JSON.parse(readFileSync(join(dir, 'task-present.jsonl'), 'utf-8').trim())
    expect(line.state_features.diffSize).toBe(80)
    expect(line.state_features.contextPct).toBe(0.35)
    expect(line.reward_components.varietyEntropy).toBe(0.69)
  })
})
