import { execFileSync } from 'child_process'
import { join, dirname } from 'path'

type RecalledMemory = {
  type: string
  content: string
  context?: string
  confidence?: string
  rrf_score?: number
}

/**
 * Recall memories from archival storage via Python subprocess.
 * Returns empty array if database is unavailable or scripts aren't installed.
 */
export async function recallMemories(query: string, k: number = 5): Promise<RecalledMemory[]> {
  try {
    // scripts/ is at repo root, at repo root level
    const scriptsDir = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..', 'scripts')
    const recallScript = join(scriptsDir, 'recall.py')
    const result = execFileSync(
      'python3',
      [recallScript, '--query', query, '--k', String(k), '--text-only'],
      { timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return JSON.parse(result)
  } catch {
    // Database not running, Python not installed, etc.
    return []
  }
}

/**
 * Format recalled memories into a system prompt section.
 */
export function formatRecalledMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return ''

  const lines = ['## Recalled Learnings', '']
  for (const m of memories) {
    const conf = m.confidence ? ` (${m.confidence} confidence)` : ''
    lines.push(`- **[${m.type}]**${conf}: ${m.content}`)
    if (m.context) lines.push(`  _Context: ${m.context}_`)
  }
  return lines.join('\n')
}
