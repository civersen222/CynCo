// engine/skills/prompt.ts
// Formats the skill-index block: the one-line-per-skill catalogue that enters
// the system prompt so the model knows what run_skill can load. Entries are
// sorted by name so the store's insertion order can never perturb the prompt
// prefix (llama.cpp checkpoint caching needs a byte-stable prefix across turns;
// skills are session-static, so this block is identical on every turn).

import type { SkillIndexEntry } from './types.js'

export function formatSkillIndexBlock(index: SkillIndexEntry[]): string | null {
  if (index.length === 0) return null
  const sorted = [...index].sort((a, b) => a.name.localeCompare(b.name))
  const lines = sorted.map(e => `- ${e.name}: ${e.description}`)
  return (
    'Skills available — call run_skill with a name to load its full instructions and tools:\n' +
    lines.join('\n')
  )
}
