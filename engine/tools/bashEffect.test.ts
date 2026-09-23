import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bashEffect, type BashEffect } from './bashEffect.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(join(here, 'bashEffect.vectors.json'), 'utf8')) as Record<BashEffect, string[]>

describe('bashEffect', () => {
  for (const [expected, commands] of Object.entries(vectors)) {
    for (const cmd of commands) {
      it(`${expected}: ${cmd.slice(0, 60)}`, () => {
        expect(bashEffect(cmd)).toBe(expected as BashEffect)
      })
    }
  }
  it('a pipeline that reads then runs is run, not read', () => {
    expect(bashEffect('cat x.py | python')).toBe('run')
  })
})
