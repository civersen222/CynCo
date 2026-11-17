/**
 * The Brain tab says which model its lens was computed for (owner's decision sheet of
 * 2026-11-17, row 28, F233 j).
 *
 * The Jacobian lens the sidecar loads was computed for Qwen3.6-27B and the model being served is
 * Qwen3.8. A readout through a lens for another model is not what it looks like, and nothing on
 * the tab said so. The name comes from the sidecar's own `/health` (its `JLENS_MODEL_REPO`), so
 * the label changes by itself the day the lens is recomputed; the page holds no model name.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function extractFunction(name: string): string {
  const startAt = html.indexOf('function ' + name + '(')
  if (startAt < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = html.indexOf('{', startAt); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(startAt, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

const brainLensLabel = new Function(`${extractFunction('brainLensLabel')}; return brainLensLabel;`)() as (msg: any) => string

describe('the lens label on the Brain tab', () => {
  it('names the model the sidecar says its lens is for, and what that means for a readout', () => {
    expect(brainLensLabel({ tier: 'live', lens: true, lensModel: 'Qwen/Qwen3.6-27B' }))
      .toBe('lens computed for Qwen/Qwen3.6-27B · a readout means what it says only while that is the model being served')
  })

  it('a sidecar that is up and does not say (one started before this change) is said, not guessed', () => {
    expect(brainLensLabel({ tier: 'live', lens: true, lensModel: null })).toBe('lens: the sidecar does not report which model it was computed for')
    expect(brainLensLabel({ tier: 'live', lens: true })).toBe('lens: the sidecar does not report which model it was computed for')
  })

  it('says nothing when there is no lens to label', () => {
    expect(brainLensLabel({ tier: 'entropy-only', lens: false, lensModel: null })).toBe('')
    expect(brainLensLabel({})).toBe('')
  })

  it('the page holds no model name of its own: the label is the frame\'s', () => {
    expect(extractFunction('brainLensLabel')).not.toMatch(/Qwen|qwen|3\.6|3\.8/)
  })

  it('the tier frame draws it, as text, into its own line of the Brain pane', () => {
    expect(html).toContain('id="brain-lens-model"')
    const onTier = extractFunction('brainOnTier')
    expect(onTier).toContain("document.getElementById('brain-lens-model')")
    expect(onTier).toContain('.textContent = brainLensLabel(msg)')
  })
})
