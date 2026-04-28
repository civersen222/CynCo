import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Handoff } from './types.js'

export function serializeHandoff(handoff: Handoff): string {
  const lines: string[] = []
  lines.push(`goal: ${handoff.goal}`)
  lines.push(`now: ${handoff.now}`)
  lines.push(`status: ${handoff.status}`)

  if (handoff.model) lines.push(`model: ${handoff.model}`)
  if (handoff.context_at_exit != null) lines.push(`context_at_exit: ${handoff.context_at_exit}`)

  const arrayField = (name: string, arr?: string[]) => {
    if (!arr || arr.length === 0) return
    lines.push(`${name}:`)
    for (const item of arr) lines.push(`  - ${item}`)
  }

  arrayField('what_was_done', handoff.what_was_done)
  arrayField('what_failed', handoff.what_failed)
  arrayField('next_steps', handoff.next_steps)
  arrayField('files_modified', handoff.files_modified)
  arrayField('learnings', handoff.learnings)

  return lines.join('\n') + '\n'
}

export function deserializeHandoff(yaml: string): Handoff {
  const result: Record<string, any> = {}
  let currentArray: string | null = null

  for (const line of yaml.split('\n')) {
    if (line.startsWith('  - ') && currentArray) {
      if (!result[currentArray]) result[currentArray] = []
      result[currentArray].push(line.slice(4))
      continue
    }

    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      if (value === '') {
        currentArray = key
      } else {
        currentArray = null
        if (key === 'context_at_exit') {
          result[key] = parseFloat(value)
        } else {
          result[key] = value
        }
      }
    }
  }

  return result as Handoff
}

export async function writeHandoff(handoff: Handoff, dir: string, topic: string): Promise<string> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const now = new Date()
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeTopic = topic.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 50)
  const filename = `${ts}_${safeTopic}.yml`
  const filePath = join(dir, filename)

  writeFileSync(filePath, serializeHandoff(handoff), 'utf-8')
  return filePath
}

export async function readHandoff(filePath: string): Promise<Handoff> {
  const content = readFileSync(filePath, 'utf-8')
  return deserializeHandoff(content)
}
