import { describe, expect, it } from 'bun:test'
import type { Profile, ResolvedProfile } from '../../profiles/types.js'
import { resolveProfile } from '../../profiles/resolver.js'

/**
 * Tests for profile inheritance resolver.
 *
 * Uses a mock loader function to avoid filesystem dependencies.
 * The resolver follows `extends:` chains, merging parent fields into children,
 * with child values taking precedence.
 */

// ---- helpers ----

/** Create a mock loader from a map of name -> Profile */
function mockLoader(profiles: Record<string, Profile>): (name: string) => Profile | null {
  return (name: string) => profiles[name] ?? null
}

// ---- resolveProfile ----

describe('resolveProfile', () => {
  it('returns profile as-is when no extends field', () => {
    const profiles: Record<string, Profile> = {
      'simple': {
        name: 'simple',
        model: 'llama3:8b',
        temperature: 0.5,
        max_output_tokens: 4096,
      },
    }
    const result = resolveProfile('simple', mockLoader(profiles))
    expect(result.name).toBe('simple')
    expect(result.model).toBe('llama3:8b')
    expect(result.temperature).toBe(0.5)
    expect(result.max_output_tokens).toBe(4096)
    // extends should not appear on resolved
    expect('extends' in result).toBe(false)
  })

  it('merges parent fields into child', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        temperature: 0.7,
        max_output_tokens: 8192,
        timeout: 60000,
        base_url: 'http://localhost:11434',
      },
      'child': {
        name: 'child',
        extends: 'parent',
        model: 'codellama:13b',
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.name).toBe('child')
    expect(result.model).toBe('codellama:13b')
    // Inherited from parent
    expect(result.temperature).toBe(0.7)
    expect(result.max_output_tokens).toBe(8192)
    expect(result.timeout).toBe(60000)
    expect(result.base_url).toBe('http://localhost:11434')
  })

  it('child values override parent values', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        model: 'parent-model:7b',
        temperature: 0.7,
        max_output_tokens: 8192,
      },
      'child': {
        name: 'child',
        extends: 'parent',
        model: 'child-model:13b',
        temperature: 0.3,
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.model).toBe('child-model:13b')
    expect(result.temperature).toBe(0.3)
    // Inherited, not overridden
    expect(result.max_output_tokens).toBe(8192)
  })

  it('handles 2-level inheritance (grandparent -> parent -> child)', () => {
    const profiles: Record<string, Profile> = {
      'grandparent': {
        name: 'grandparent',
        base_url: 'http://gpu-server:11434',
        timeout: 120000,
        temperature: 0.8,
      },
      'parent': {
        name: 'parent',
        extends: 'grandparent',
        model: 'parent-model:7b',
        temperature: 0.5,
      },
      'child': {
        name: 'child',
        extends: 'parent',
        model: 'child-model:33b',
        max_output_tokens: 16384,
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.name).toBe('child')
    expect(result.model).toBe('child-model:33b')
    expect(result.max_output_tokens).toBe(16384)
    // From parent
    expect(result.temperature).toBe(0.5)
    // From grandparent
    expect(result.base_url).toBe('http://gpu-server:11434')
    expect(result.timeout).toBe(120000)
  })

  it('caps inheritance at depth 5 (circular reference protection)', () => {
    const profiles: Record<string, Profile> = {
      'a': { name: 'a', extends: 'b', model: 'model-a' },
      'b': { name: 'b', extends: 'c', model: 'model-b' },
      'c': { name: 'c', extends: 'd', model: 'model-c' },
      'd': { name: 'd', extends: 'e', model: 'model-d' },
      'e': { name: 'e', extends: 'f', model: 'model-e' },
      'f': { name: 'f', extends: 'a', model: 'model-f' },  // circular!
    }
    // Should not throw or infinite loop; should stop at depth 5
    const result = resolveProfile('a', mockLoader(profiles))
    expect(result.name).toBe('a')
    expect(result.model).toBe('model-a')
  })

  it('tools.allowed in child replaces parent (not union)', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        tools: {
          allowed: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          denied: ['WebSearch'],
        },
      },
      'child': {
        name: 'child',
        extends: 'parent',
        tools: {
          allowed: ['Read', 'Grep'],
        },
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    // Child's tools.allowed replaces parent's, not union
    expect(result.tools!.allowed).toEqual(['Read', 'Grep'])
    // Child didn't specify denied, but since child provides tools object,
    // parent's denied should still be inherited at the field level
    // (tools is merged shallowly, so child.tools replaces parent.tools entirely)
    // Actually: tools as a whole object: child replaces parent
    // The spec says "arrays replace (not merge)" and "tools: child's allowed/denied replace parent's"
    // This means the child's tools object replaces the parent's tools object completely
    expect(result.tools!.denied).toBeUndefined()
  })

  it('tools.denied in child replaces parent denied', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        tools: {
          denied: ['WebSearch', 'WebFetch'],
        },
      },
      'child': {
        name: 'child',
        extends: 'parent',
        tools: {
          denied: ['Agent'],
        },
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.tools!.denied).toEqual(['Agent'])
  })

  it('capabilities merge from parent when child does not specify', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        capabilities: {
          tool_use: 'native',
          thinking: 'simulated',
          vision: false,
        },
      },
      'child': {
        name: 'child',
        extends: 'parent',
        model: 'some-model',
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.capabilities).toEqual({
      tool_use: 'native',
      thinking: 'simulated',
      vision: false,
    })
  })

  it('returns profile with name when extends target not found', () => {
    const profiles: Record<string, Profile> = {
      'orphan': {
        name: 'orphan',
        extends: 'nonexistent-parent',
        model: 'some-model',
      },
    }
    // Should not throw; just return the profile without parent merging
    const result = resolveProfile('orphan', mockLoader(profiles))
    expect(result.name).toBe('orphan')
    expect(result.model).toBe('some-model')
  })

  it('throws when profile name not found', () => {
    const profiles: Record<string, Profile> = {}
    expect(() => resolveProfile('missing', mockLoader(profiles))).toThrow()
  })

  it('system_prompt_append from child overrides parent', () => {
    const profiles: Record<string, Profile> = {
      'parent': {
        name: 'parent',
        system_prompt_append: 'Parent system prompt.',
      },
      'child': {
        name: 'child',
        extends: 'parent',
        system_prompt_append: 'Child system prompt.',
      },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    expect(result.system_prompt_append).toBe('Child system prompt.')
  })
})
