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

  // F172: a capitalised name, a GGUF file name or a path used to miss the
  // lower-case table, resolve to toolUse 'none' and send no tools at all.
  it('ignores case, a .gguf extension, a directory and an hf.co prefix', () => {
    expect(parseModelFamily('Qwen3.8-27B')).toBe('qwen3.8-27b')
    expect(parseModelFamily('Qwen3:32B')).toBe('qwen3')
    expect(parseModelFamily('Qwen3.8-27B-Q4_K_M.gguf')).toBe('qwen3.8-27b-q4_k_m')
    expect(parseModelFamily('C:\\models\\Qwen3.8-27B-Q4_K_M.gguf')).toBe('qwen3.8-27b-q4_k_m')
    expect(parseModelFamily('/opt/models/Qwen3.8-27B-Q4_K_M.GGUF')).toBe('qwen3.8-27b-q4_k_m')
    expect(parseModelFamily('hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M')).toBe('qwen3-8b-gguf')
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

describe('local model directory names', () => {
  // llama.cpp profiles name models after their download directory, e.g.
  // 'qwen3.8-27b-nvfp4', which has no colon to strip. A family missing from the
  // table resolves to toolUse:'none', which means callModel sends no tools array
  // at all and the model answers in prose forever. These are the names actually
  // in ~/.cynco/profiles.
  it.each([
    ['qwen3.8-27b-nvfp4', 'native'],
    ['qwen3.6-27b-nvfp4', 'native'],
    ['qwen3.6-mtp', 'native'],
  ])('%s resolves to %s tool use', (model, toolUse) => {
    expect(resolveCapabilities(model).toolUse).toBe(toolUse as 'native')
  })
})

describe('resolveCapabilities', () => {
  it('resolves a capitalised, file-named or pathed model to its family (F172)', () => {
    for (const name of ['Qwen3.8-27B', 'QWEN3.8-27B', 'Qwen3.8-27B-Q4_K_M.gguf', 'C:\\models\\Qwen3.8-27B-Q4_K_M.gguf']) {
      expect(resolveCapabilities(name).toolUse, name).toBe('native')
      expect(resolveCapabilities(name).contextLength, name).toBe(KNOWN_MODEL_CAPABILITIES.get('qwen3.8')!.contextLength)
    }
    expect(resolveCapabilities('Llama3.1:8B').toolUse).toBe('simulated')
    expect(resolveCapabilities('DeepSeek-R1:14b').toolUse).toBe('none')
    expect(lookupKnownCapabilities('Mistral-Nemo')).toBe(KNOWN_MODEL_CAPABILITIES.get('mistral-nemo'))
    // still unknown is still unknown
    expect(resolveCapabilities('Totally-Unknown-Model').toolUse).toBe('none')
  })

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
