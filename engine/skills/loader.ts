// engine/skills/loader.ts
// Discovers skills from a bundled builtin dir and a per-user workspace dir.
// Each skill is a folder containing a SKILL.md whose leading `---`-fenced YAML
// block is the frontmatter. Only the validated frontmatter enters memory here;
// the prose body is read lazily from `bodyPath` when a skill actually runs.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { validateFrontmatter, type Skill, type SkillIndexEntry } from './types.js'

/** Parse YAML using Bun's built-in parser, with npm `yaml` fallback. */
function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return (Bun as any).YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}

/** The bundled builtin skills directory (populated in Phase 4). */
export function builtinSkillsDir(): string {
  return path.join(import.meta.dirname, 'builtins')
}

/** The per-user workspace skills directory (`~/.cynco/skills`). */
export function workspaceSkillsDir(): string {
  const home = process.env.HOME || os.homedir()
  return path.join(home, '.cynco', 'skills')
}

/**
 * Split a SKILL.md into its leading `---`-fenced frontmatter block and the rest.
 * Returns null if there is no well-formed frontmatter fence.
 */
function splitFrontmatter(text: string): string | null {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return null
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return null
  // Skip past the opening `---` line.
  const firstNewline = normalized.indexOf('\n')
  if (firstNewline === -1 || firstNewline >= end) return null
  return normalized.slice(firstNewline + 1, end)
}

/**
 * Read a SKILL.md and return only its prose body (the frontmatter fence
 * stripped). This is what gets appended to context when a skill runs.
 */
export function readSkillBody(bodyPath: string): string {
  const text = fs.readFileSync(bodyPath, 'utf8').replace(/^\uFEFF/, '')
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      const afterFence = text.indexOf('\n', end + 1)
      if (afterFence !== -1) return text.slice(afterFence + 1).replace(/^\s+/, '')
    }
  }
  return text
}

function scanDir(
  root: string,
  source: Skill['source'],
  knownTools: ReadonlySet<string>,
): Skill[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // dir absent — nothing to load
  }

  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const bodyPath = path.join(dir, 'SKILL.md')
    let text: string
    try {
      text = fs.readFileSync(bodyPath, 'utf8')
    } catch {
      continue // no SKILL.md — not a skill folder
    }
    const fmText = splitFrontmatter(text)
    if (fmText === null) {
      console.warn(`[skills] ${bodyPath}: missing frontmatter fence, skipping`)
      continue
    }
    try {
      const raw = parseYaml(fmText)
      const frontmatter = validateFrontmatter(raw, knownTools)
      skills.push({ frontmatter, dir, source, bodyPath })
    } catch (err) {
      console.warn(`[skills] ${bodyPath}: ${(err as Error).message}, skipping`)
    }
  }
  return skills
}

export type LoadSkillsOptions = {
  builtinDir?: string
  workspaceDir?: string
  knownTools: ReadonlySet<string>
}

/**
 * Scan both skill directories and return the parsed skills plus a compact index
 * (one entry per skill: name, description, source) for the skill-index prompt
 * block. Workspace skills override builtins of the same name.
 */
export async function loadSkills(
  opts: LoadSkillsOptions,
): Promise<{ skills: Skill[]; index: SkillIndexEntry[] }> {
  const builtinDir = opts.builtinDir ?? builtinSkillsDir()
  const workspaceDir = opts.workspaceDir ?? workspaceSkillsDir()

  const builtins = scanDir(builtinDir, 'builtin', opts.knownTools)
  const workspace = scanDir(workspaceDir, 'workspace', opts.knownTools)

  const byName = new Map<string, Skill>()
  for (const s of builtins) byName.set(s.frontmatter.name, s)
  for (const s of workspace) byName.set(s.frontmatter.name, s) // workspace wins

  const skills = [...byName.values()]
  const index: SkillIndexEntry[] = skills.map(s => ({
    name: s.frontmatter.name,
    description: s.frontmatter.description,
    source: s.source,
  }))
  return { skills, index }
}
