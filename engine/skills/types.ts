// engine/skills/types.ts
// Skill = a directory with a SKILL.md whose leading `---`-fenced YAML block is
// the frontmatter. Frontmatter is validated with a hand-written checker (not
// Zod) so we keep the zero-runtime-dep posture; the body is loaded lazily.

export type SkillFrontmatter = {
  name: string
  description: string
  version?: string
  author?: string
  tools: string[]
}

export type Skill = {
  frontmatter: SkillFrontmatter
  dir: string
  source: 'builtin' | 'workspace'
  bodyPath: string
}

export type SkillIndexEntry = {
  name: string
  description: string
  source: Skill['source']
}

/**
 * Tools that can mutate the filesystem, run commands, or reach the network.
 * A skill that lists any of these is surfaced with a warning at install time so
 * the user can eyeball what they're granting.
 */
export const RISKY_TOOLS = new Set([
  'Bash',
  'Git',
  'Write',
  'Edit',
  'MultiEdit',
  'ApplyPatch',
  'ReplaceFunction',
  'WebFetch',
])

/**
 * Validate a parsed YAML frontmatter mapping against the SkillFrontmatter shape.
 * Throws a descriptive Error on the first violation. `knownTools` is the set of
 * registry tool names — any tool a skill references must exist.
 */
export function validateFrontmatter(
  raw: unknown,
  knownTools: ReadonlySet<string>,
): SkillFrontmatter {
  if (raw === null || typeof raw !== 'object') throw new Error('frontmatter: not a mapping')
  const o = raw as Record<string, unknown>

  const name = o.name
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`frontmatter.name: must be lower-kebab-case (got ${JSON.stringify(name)})`)
  }

  if (typeof o.description !== 'string' || o.description.trim() === '' || o.description.includes('\n')) {
    throw new Error('frontmatter.description: required single-line string')
  }

  const tools = o.tools ?? []
  if (!Array.isArray(tools) || tools.some(t => typeof t !== 'string')) {
    throw new Error('frontmatter.tools: must be an array of tool-name strings')
  }
  const unknown = (tools as string[]).filter(t => !knownTools.has(t))
  if (unknown.length) throw new Error(`frontmatter.tools: unknown tool(s): ${unknown.join(', ')}`)

  if (o.version !== undefined && typeof o.version !== 'string') throw new Error('frontmatter.version: string')
  if (o.author !== undefined && typeof o.author !== 'string') throw new Error('frontmatter.author: string')

  return {
    name,
    description: o.description,
    version: o.version as string | undefined,
    author: o.author as string | undefined,
    tools: tools as string[],
  }
}
