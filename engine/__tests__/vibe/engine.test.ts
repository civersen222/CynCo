import { describe, expect, it } from 'bun:test'
import { VibeLoopEngine } from '../../vibe/engine.js'
import type { VibeEvent } from '../../vibe/types.js'

function createEngine() {
  const events: VibeEvent[] = []
  const engine = new VibeLoopEngine((e) => events.push(e))
  return { engine, events }
}

describe('VibeLoopEngine', () => {
  it('starts in idle state', () => {
    const { engine } = createEngine()
    expect(engine.state).toBe('idle')
  })

  it('transitions to understand on start', () => {
    const { engine, events } = createEngine()
    engine.start('new', 'add a settings page')
    expect(engine.state).toBe('understand')
    expect(events[0]).toEqual({
      type: 'vibe.state_changed',
      fromState: 'idle',
      to: 'understand',
    })
  })

  it('classifies difficulty on start', () => {
    const { engine } = createEngine()
    engine.start('new', 'make button blue')
    expect(engine.difficulty).toBe('trivial')
  })

  it('creates confidence scorer on start', () => {
    const { engine } = createEngine()
    engine.start('new', 'add settings page')
    expect(engine.confidence).not.toBeNull()
    expect(engine.confidence!.overall()).toBe(0)
  })

  it('updates confidence and emits event', () => {
    const { engine, events } = createEngine()
    engine.start('new', 'build a todo app')
    events.length = 0

    engine.updateConfidence('purpose', 80, 'user explained goal')
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('vibe.confidence_update')
    if (events[0].type === 'vibe.confidence_update') {
      expect(events[0].overall).toBe(0) // other dims still 0
      expect(events[0].confidence.purpose).toBe(80)
    }
  })

  it('transitions to build', () => {
    const { engine, events } = createEngine()
    engine.start('new', 'something')
    events.length = 0

    engine.transitionToBuild()
    expect(engine.state).toBe('build')
    expect(events[0]).toEqual({
      type: 'vibe.state_changed',
      fromState: 'understand',
      to: 'build',
    })
  })

  it('completes task and transitions to report', () => {
    const { engine, events } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    events.length = 0

    engine.completeTask('Added button', 'Like adding a doorbell', ['src/app.ts'], 'Try adding a form next')
    expect(engine.state).toBe('report')
    expect(events[0]).toEqual({
      type: 'vibe.state_changed',
      fromState: 'build',
      to: 'report',
    })
    expect(events[1].type).toBe('vibe.task_complete')
    if (events[1].type === 'vibe.task_complete') {
      expect(events[1].title).toBe('Added button')
      expect(events[1].suggestion).toBe('Try adding a form next')
    }
  })

  it('accept_suggestion transitions to understand', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.completeTask('Done', 'analogy', [], 'next')

    engine.handleAction('accept_suggestion')
    expect(engine.state).toBe('understand')
  })

  it('something_else transitions to understand', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.completeTask('Done', 'analogy', [], 'next')

    engine.handleAction('something_else')
    expect(engine.state).toBe('understand')
  })

  it('done transitions to idle', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.completeTask('Done', 'analogy', [], 'next')

    engine.handleAction('done')
    expect(engine.state).toBe('idle')
  })

  it('just_build transitions to build', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')

    engine.handleAction('just_build')
    expect(engine.state).toBe('build')
  })

  it('skip transitions to understand', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()

    engine.handleAction('skip')
    expect(engine.state).toBe('understand')
  })

  it('fix transitions to understand', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()

    engine.handleAction('fix')
    expect(engine.state).toBe('understand')
  })

  it('escalate transitions to escalation and emits event', () => {
    const { engine, events } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    events.length = 0

    engine.escalate('type error', ['checked imports', 'added types'], 'need to refactor module')
    expect(engine.state).toBe('escalation')
    expect(events[0]).toEqual({
      type: 'vibe.state_changed',
      fromState: 'build',
      to: 'escalation',
    })
    expect(events[1].type).toBe('vibe.escalation')
    if (events[1].type === 'vibe.escalation') {
      expect(events[1].problem).toBe('type error')
      expect(events[1].tried).toEqual(['checked imports', 'added types'])
      expect(events[1].proposal).toBe('need to refactor module')
    }
  })

  it('escalation response skip goes to understand', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.escalate('problem', [], 'proposal')

    engine.handleEscalationResponse('skip')
    expect(engine.state).toBe('understand')
  })

  it('escalation response fix goes to build', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.escalate('problem', [], 'proposal')

    engine.handleEscalationResponse('fix')
    expect(engine.state).toBe('build')
  })

  it('escalation response explain goes to build', () => {
    const { engine } = createEngine()
    engine.start('new', 'something')
    engine.transitionToBuild()
    engine.escalate('problem', [], 'proposal')

    engine.handleEscalationResponse('explain')
    expect(engine.state).toBe('build')
  })
})
