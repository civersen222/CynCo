// engine/skills/scaffold.ts
// `/skill new <name>` — creates a starter skill folder under the workspace
// skills dir with a template SKILL.md whose frontmatter already validates.

import * as fs from 'fs'
import * as path from 'path'
import { resolveWorkspaceSkillDir } from './loader.js'

export type ScaffoldResult = { name: string; dir: string; bodyPath: string }

function template(name: string): string {
  return `---
name: ${name}
description: One-line description of what this skill does
version: 0.1.0
tools: []
---

# ${name}

Describe the workflow here. This body is loaded into context when the model
calls run_skill("${name}"). List any tools the skill needs in the frontmatter
\`tools:\` array — they are surfaced automatically when the skill runs.
`
}

export function scaffoldSkill(name: string, opts?: { workspaceDir?: string }): ScaffoldResult {
  const dir = resolveWorkspaceSkillDir(name, opts?.workspaceDir)
  if (fs.existsSync(dir)) throw new Error(`skill "${name}" already exists at ${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  const bodyPath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(bodyPath, template(name))
  return { name, dir, bodyPath }
}
