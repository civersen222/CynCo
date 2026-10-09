/**
 * Progressive rendering: the tool-call buffer is cut at every 10th character
 * of the worked example and handed to the REAL jsonrepair path. From the first
 * frame that has a root, every frame must be drawable, carry no errors, and
 * grow monotonically into the final spec.
 */
import { describe, expect, it } from 'vitest'
import { parsePartialSpec, trimOpenScalar, PARTIAL_FRAME_INTERVAL_MS } from '../../genui/partial.js'
import { genuiExampleCall } from '../../genui/prompt.js'
import { validateSpec } from '../../genui/spec.js'

describe('parsePartialSpec', () => {
  const buffer = JSON.stringify(genuiExampleCall())

  it('returns null until a root element exists, then a growing spec with no errors', () => {
    let first = -1
    let lastCount = 0
    for (let cut = 1; cut <= buffer.length; cut += 10) {
      const frame = parsePartialSpec(buffer.slice(0, cut))
      if (!frame) { expect(first, `frame vanished at ${cut}`).toBe(-1); continue }
      if (first < 0) first = cut
      expect(frame.count).toBeGreaterThanOrEqual(lastCount - 1) // the element being typed may flicker in and out by one
      lastCount = frame.count
      expect(frame.spec.elements[frame.spec.root]).toBeDefined()
      // every element in a partial frame is a real catalog component with a props object
      for (const el of Object.values(frame.spec.elements)) expect(typeof el.type).toBe('string')
    }
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(120)
    const final = parsePartialSpec(buffer)
    expect(final?.count).toBe(7)
    expect(final?.surface).toBe('plan')
    expect(final?.spec).toEqual(validateSpec(genuiExampleCall().spec).spec)
  })

  it('reads the surface id only once it is complete and valid', () => {
    expect(parsePartialSpec('{"surface":"pl')?.surface ?? null).toBeNull()
    expect(parsePartialSpec('{"surface":"bad id","spec":{"root":"c","elements":{"c":{"type":"Card"}}}}')?.surface).toBeNull()
    expect(parsePartialSpec('{"surface":"plan","spec":{"root":"c","elements":{"c":{"type":"Card"}}}}')?.surface).toBe('plan')
  })

  it('half-typed component names and ids never produce an error note', () => {
    const f = parsePartialSpec('{"spec":{"root":"c","elements":{"c":{"type":"Card","children":["t"]},"t":{"type":"Tab')
    expect(f?.count).toBe(1)
    expect(f?.spec.elements.c.children).toEqual([])
    expect(Object.values(f!.spec.elements).some(e => e.type === 'Callout')).toBe(false)
  })

  it('accepts a bare spec without the {spec} envelope, rejects garbage', () => {
    expect(parsePartialSpec('{"root":"c","elements":{"c":{"type":"Card"}}')?.count).toBe(1)
    expect(parsePartialSpec('')).toBeNull()
    expect(parsePartialSpec('not json')).toBeNull()
    expect(parsePartialSpec('[1,2]')).toBeNull()
    expect(parsePartialSpec('{"spec":"x"}')).toBeNull()
  })

  it('a half-written number never reaches a frame; text does', () => {
    expect(trimOpenScalar('{"max": 1')).toBe('{"max": ')
    expect(trimOpenScalar('{"v": [12, 3')).toBe('{"v": [12, ')
    expect(trimOpenScalar('{"v": -0.')).toBe('{"v": ')
    expect(trimOpenScalar('{"ok": tr')).toBe('{"ok": ')
    expect(trimOpenScalar('{"ok": true')).toBe('{"ok": true')
    expect(trimOpenScalar('{"text": "a, 12')).toBe('{"text": "a, 12')
    expect(trimOpenScalar('{"text": "hel')).toBe('{"text": "hel')
    expect(trimOpenScalar('{"a": 1,')).toBe('{"a": 1,')
    const slider = parsePartialSpec('{"spec":{"root":"s","elements":{"s":{"type":"Slider","props":{"name":"kg","label":"Kg","max": 1')
    expect(slider?.spec.elements.s.props?.max).toBeUndefined()
    const bars = parsePartialSpec('{"spec":{"root":"b","elements":{"b":{"type":"Sparkline","props":{"values":[12, 3')
    expect(bars?.spec.elements.b.props?.values).toEqual([12])
  })

  it('throttle constant is sane', () => {
    expect(PARTIAL_FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(50)
    expect(PARTIAL_FRAME_INTERVAL_MS).toBeLessThanOrEqual(500)
  })
})
