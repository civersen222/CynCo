// engine/skills/store.ts
// A process-wide singleton holding the skills discovered at conversation-loop
// startup. Meta-tools (run_skill / list_skills) read from here via dynamic
// import — the same decoupling load_tools uses for the tool registry — so tool
// modules never take a circular dependency on the loop.

import type { Skill, SkillIndexEntry } from './types.js'

let SKILLS: Skill[] = []

export function setLoadedSkills(skills: Skill[]): void {
  SKILLS = skills
}

export function getLoadedSkills(): Skill[] {
  return SKILLS
}

export function getSkillByName(name: string): Skill | undefined {
  return SKILLS.find(s => s.frontmatter.name === name)
}

export function getSkillIndex(): SkillIndexEntry[] {
  return SKILLS.map(s => ({
    name: s.frontmatter.name,
    description: s.frontmatter.description,
    source: s.source,
  }))
}
