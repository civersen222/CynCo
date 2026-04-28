import { describe, expect, it } from 'bun:test'
import { applyPatchTool } from '../../tools/impl/applyPatch.js'

describe('ApplyPatch tool', () => {
  it('has correct metadata', () => {
    expect(applyPatchTool.name).toBe('ApplyPatch')
    expect(applyPatchTool.tier).toBe('approval')
  })

  it('returns error on invalid patch', async () => {
    const result = await applyPatchTool.execute({
      patch: 'not a valid patch\n',
      check: true,
    }, process.cwd())
    // Should return isError: true since the patch is invalid
    expect(result.isError).toBe(true)
  })

  it('has correct input schema', () => {
    expect(applyPatchTool.inputSchema.required).toContain('patch')
  })
})
