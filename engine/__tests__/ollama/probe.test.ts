import { describe, expect, it } from 'bun:test'
import {
  parseModelFamily, lookupKnownCapabilities, resolveCapabilities,
  KNOWN_MODEL_CAPABILITIES,
} from '../../ollama/probe.js'

describe('parseModelFamily', () => {
  it('extracts family from Ollama model names', () => {
    expect(parseModelFamily('qwen3:32b')).toBe('qwen3')
    expect(parseModelFamily('llama3.1:8b-instruct-q4_0')).toBe('llama3.1')
    expect(parseModelFamily('deepseek-r1:14b')).toBe('deepseek-r1')
    expect(parseModelFamily('phi4')).toBe('phi4')
    expect(parseModelFamily('gemma:7b')).toBe('gemma')
  })
})

describe('KNOWN_MODEL_CAPABILITIES', () => {
  it('has correct tiers for spec-defined models', () => {
    expect(KNOWN_MODEL_CAPABILITIES.get('qwen3')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('llama4')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('mistral')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('phi4')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('llama3.1')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('deepseek-r1')?.toolUse).toBe('none')
    expect(KNOWN_MODEL_CAPABILITIES.get('gemma')?.toolUse).toBe('none')
  })

  it('has correct tiers for plan-added models', () => {
    // Native tool use
    expect(KNOWN_MODEL_CAPABILITIES.get('qwen2.5')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('mistral-large')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('mistral-nemo')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('command-r')?.toolUse).toBe('native')
    expect(KNOWN_MODEL_CAPABILITIES.get('command-r-plus')?.toolUse).toBe('native')
    // Simulated tool use
    expect(KNOWN_MODEL_CAPABILITIES.get('llama3.3')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('llama3.2')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('phi3')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('deepseek-v3')?.toolUse).toBe('simulated')
    expect(KNOWN_MODEL_CAPABILITIES.get('gemma2')?.toolUse).toBe('simulated')
    // No tool use
    expect(KNOWN_MODEL_CAPABILITIES.get('codellama')?.toolUse).toBe('none')
    expect(KNOWN_MODEL_CAPABILITIES.get('starcoder2')?.toolUse).toBe('none')
  })
})

describe('lookupKnownCapabilities', () => {
  it('returns capabilities for known families', () => {
    const result = lookupKnownCapabilities('qwen3')
    expect(result).not.toBeNull()
    expect(result!.toolUse).toBe('native')
  })

  it('returns null for unknown families', () => {
    expect(lookupKnownCapabilities('totally-unknown-model')).toBeNull()
  })
})

describe('resolveCapabilities', () => {
  it('uses known table when available', () => {
    const caps = resolveCapabilities('qwen3:32b')
    expect(caps.toolUse).toBe('native')
    expect(caps.thinking).toBeDefined()
    expect(caps.tier).toBe('advanced')
  })

  it('accepts probe result override for unknown models', () => {
    const probeResult = { toolUse: 'simulated' as const, thinking: 'none' as const, contextLength: 4096 }
    const caps = resolveCapabilities('my-custom-model:7b', probeResult)
    expect(caps.toolUse).toBe('simulated')
    expect(caps.contextLength).toBe(4096)
    expect(caps.tier).toBe('standard')
  })

  it('defaults to basic when no known entry and no probe', () => {
    const caps = resolveCapabilities('totally-unknown:3b')
    expect(caps.toolUse).toBe('none')
    expect(caps.thinking).toBe('none')
    expect(caps.tier).toBe('basic')
  })
})
