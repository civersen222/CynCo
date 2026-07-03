import { describe, test, expect, beforeEach } from 'bun:test'
import { globalContract, contractCreateTool, contractAssertPassTool } from './contract.js'

describe('contract enforcer budget', () => {
  beforeEach(async () => {
    await contractCreateTool.execute({
      title: 'budget test',
      assertions: ['a one', 'a two', 'a three', 'a four', 'a five'],
    })
  })

  test('marking assertions does not consume enforcementRounds', async () => {
    expect(globalContract.enforcementRounds).toBe(0)
    for (let i = 0; i < 5; i++) {
      await contractAssertPassTool.execute({ index: i })
    }
    expect(globalContract.enforcementRounds).toBe(0)
  })
})
