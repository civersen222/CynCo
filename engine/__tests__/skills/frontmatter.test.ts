import { describe, expect, it } from 'bun:test'
import { validateFrontmatter, RISKY_TOOLS } from '../../skills/types.js'

const KNOWN = new Set(['Read', 'Write', 'Bash', 'Grep', 'WebFetch'])

describe('validateFrontmatter', () => {
  it('accepts a minimal valid frontmatter', () => {
    const fm = validateFrontmatter(
      { name: 'my-skill', description: 'Does a thing', tools: ['Read'] },
      KNOWN,
    )
    expect(fm.name).toBe('my-skill')
    expect(fm.description).toBe('Does a thing')
    expect(fm.tools).toEqual(['Read'])
    expect(fm.version).toBeUndefined()
    expect(fm.author).toBeUndefined()
  })

  it('defaults tools to an empty array when omitted', () => {
    const fm = validateFrontmatter({ name: 'no-tools', description: 'Pure prose' }, KNOWN)
    expect(fm.tools).toEqual([])
  })

  it('carries optional version and author through', () => {
    const fm = validateFrontmatter(
      { name: 'x', description: 'd', tools: [], version: '1.2.0', author: 'jane' },
      KNOWN,
    )
    expect(fm.version).toBe('1.2.0')
    expect(fm.author).toBe('jane')
  })

  it('rejects a non-mapping', () => {
    expect(() => validateFrontmatter(null, KNOWN)).toThrow(/not a mapping/)
    expect(() => validateFrontmatter('nope', KNOWN)).toThrow(/not a mapping/)
  })

  it('rejects a name that is not lower-kebab-case', () => {
    expect(() => validateFrontmatter({ name: 'MySkill', description: 'd' }, KNOWN)).toThrow(/kebab/)
    expect(() => validateFrontmatter({ name: 'my_skill', description: 'd' }, KNOWN)).toThrow(/kebab/)
    expect(() => validateFrontmatter({ name: 'my skill', description: 'd' }, KNOWN)).toThrow(/kebab/)
    expect(() => validateFrontmatter({ name: '-lead', description: 'd' }, KNOWN)).toThrow(/kebab/)
    expect(() => validateFrontmatter({ name: 42, description: 'd' }, KNOWN)).toThrow(/kebab/)
  })

  it('rejects a missing or multi-line description', () => {
    expect(() => validateFrontmatter({ name: 'x' }, KNOWN)).toThrow(/description/)
    expect(() => validateFrontmatter({ name: 'x', description: '' }, KNOWN)).toThrow(/description/)
    expect(() => validateFrontmatter({ name: 'x', description: 'a\nb' }, KNOWN)).toThrow(/description/)
  })

  it('rejects tools that are not a string array', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', tools: 'Read' }, KNOWN)).toThrow(/tools/)
    expect(() => validateFrontmatter({ name: 'x', description: 'd', tools: [1, 2] }, KNOWN)).toThrow(/tools/)
  })

  it('rejects unknown tool names', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', tools: ['Nope'] }, KNOWN)).toThrow(/unknown tool/)
  })

  it('rejects non-string version and author', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', version: 1 }, KNOWN)).toThrow(/version/)
    expect(() => validateFrontmatter({ name: 'x', description: 'd', author: {} }, KNOWN)).toThrow(/author/)
  })

  it('flags risky tools', () => {
    expect(RISKY_TOOLS.has('Bash')).toBe(true)
    expect(RISKY_TOOLS.has('Write')).toBe(true)
    expect(RISKY_TOOLS.has('Read')).toBe(false)
  })
})
