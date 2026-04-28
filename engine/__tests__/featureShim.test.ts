import { describe, expect, it } from 'bun:test'
import { feature } from '../featureShim.js'

describe('featureShim', () => {
  it('returns true for enabled user-facing features', () => {
    expect(feature('REACTIVE_COMPACT')).toBe(true)
    expect(feature('CONTEXT_COLLAPSE')).toBe(true)
    expect(feature('BASH_CLASSIFIER')).toBe(true)
    expect(feature('COMMIT_ATTRIBUTION')).toBe(true)
    expect(feature('EXTRACT_MEMORIES')).toBe(true)
    expect(feature('FILE_PERSISTENCE')).toBe(true)
    expect(feature('CONNECTOR_TEXT')).toBe(true)
    expect(feature('TOKEN_BUDGET')).toBe(true)
    expect(feature('ULTRATHINK')).toBe(true)
    expect(feature('ULTRAPLAN')).toBe(true)
    expect(feature('TREE_SITTER_BASH')).toBe(true)
    expect(feature('STREAMLINED_OUTPUT')).toBe(true)
  })

  it('returns false for cloud-only features', () => {
    expect(feature('ABLATION_BASELINE')).toBe(false)
    expect(feature('ANTI_DISTILLATION_CC')).toBe(false)
    expect(feature('DUMP_SYSTEM_PROMPT')).toBe(false)
    expect(feature('KAIROS')).toBe(false)
    expect(feature('KAIROS_CHANNELS')).toBe(false)
    expect(feature('BRIDGE_MODE')).toBe(false)
    expect(feature('DIRECT_CONNECT')).toBe(false)
    expect(feature('CCR_AUTO_CONNECT')).toBe(false)
    expect(feature('SSH_REMOTE')).toBe(false)
    expect(feature('VOICE_MODE')).toBe(false)
    expect(feature('NATIVE_CLIENT_ATTESTATION')).toBe(false)
    expect(feature('ENHANCED_TELEMETRY_BETA')).toBe(false)
    expect(feature('TORCH')).toBe(false)
    expect(feature('LODESTONE')).toBe(false)
  })

  it('returns false for unknown flags', () => {
    expect(feature('NONEXISTENT_FLAG')).toBe(false)
  })
})
