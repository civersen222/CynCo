import { describe, it, expect } from 'bun:test'
import { iterationBudgetNotice } from '../../bridge/iterationBudget.js'

const MAX = 500

function firingIterations(max: number): number[] {
  const out: number[] = []
  for (let i = 0; i < max; i++) if (iterationBudgetNotice(i, max) !== null) out.push(i)
  return out
}

describe('iterationBudgetNotice', () => {
  it('fires exactly twice across a full 500-iteration budget', () => {
    expect(firingIterations(MAX)).toEqual([350, 450])
  })

  it('is silent for the whole first 70% of the budget', () => {
    for (let i = 0; i < 350; i++) expect(iterationBudgetNotice(i, MAX)).toBeNull()
  })

  it('names the iterations used and remaining', () => {
    const notice = iterationBudgetNotice(350, MAX)!
    expect(notice).toContain('used 350 of 500')
    expect(notice).toContain('150 remain')
  })

  it('tells the model at 70% to act on what it has rather than keep gathering', () => {
    const notice = iterationBudgetNotice(350, MAX)!
    expect(notice).toContain('stop and make the change you already have evidence for')
    expect(notice).not.toContain('last warning')
  })

  it('escalates at 90% to landing the smallest correct change', () => {
    const notice = iterationBudgetNotice(450, MAX)!
    expect(notice).toContain('last warning')
    expect(notice).toContain('Stop investigating now')
  })

  it('warns in both notices that uncommitted work does not survive the cap', () => {
    for (const i of firingIterations(MAX)) {
      expect(iterationBudgetNotice(i, MAX)).toContain('commit')
    }
  })

  // The incident this module exists for: a healthy run that spends the whole
  // budget investigating gets no stuck-loop intervention, so this is the only
  // signal it ever receives.
  it('still fires on a budget raised by LOCALCODE_MAX_ITERATIONS', () => {
    expect(firingIterations(1200)).toEqual([840, 1080])
  })

  it('never fires more than once per threshold on small budgets', () => {
    expect(firingIterations(10)).toEqual([7, 9])
    expect(firingIterations(4)).toEqual([2, 3])
  })

  it('collapses to a single notice when both thresholds land on one iteration', () => {
    // max=3 -> floor(2.1)=2 and floor(2.7)=2; the notice must not double up.
    expect(firingIterations(3)).toEqual([2])
    expect(iterationBudgetNotice(2, 3)).toContain('used 2 of 3')
  })

  it('returns null for a non-positive or non-finite budget', () => {
    expect(iterationBudgetNotice(0, 0)).toBeNull()
    expect(iterationBudgetNotice(5, -1)).toBeNull()
    expect(iterationBudgetNotice(5, Number.NaN)).toBeNull()
    expect(iterationBudgetNotice(5, Number.POSITIVE_INFINITY)).toBeNull()
  })
})
