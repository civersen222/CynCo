import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Handoff } from './types.js'
import type { ContractSnapshot } from '../tools/contract.js'

export type HandoffFromContractOptions = {
  utilization?: number
  model?: string
  filesModified?: string[]
}

/**
 * Build a content-rich Handoff from a contract snapshot. Passed assertions
 * become what_was_done, failed become what_failed, and pending become
 * next_steps — turning the Definition-of-Done state into real continuity.
 */
export function handoffFromContract(
  snapshot: ContractSnapshot,
  opts: HandoffFromContractOptions,
): Handoff {
  const withEvidence = (a: { text: string; evidence?: string }) =>
    a.evidence ? `${a.text} — ${a.evidence}` : a.text

  const done = snapshot.assertions.filter(a => a.status === 'passed').map(withEvidence)
  const failed = snapshot.assertions.filter(a => a.status === 'failed').map(withEvidence)
  const pending = snapshot.assertions.filter(a => a.status === 'pending').map(a => a.text)

  const handoff: Handoff = {
    goal: snapshot.title || 'Untitled task',
    now: snapshot.brief || (snapshot.complete ? 'Task complete' : 'Work in progress'),
    status: snapshot.complete ? 'complete' : 'in_progress',
  }

  if (opts.utilization != null) handoff.context_at_exit = opts.utilization
  if (opts.model) handoff.model = opts.model
  if (done.length > 0) handoff.what_was_done = done
  if (failed.length > 0) handoff.what_failed = failed
  if (pending.length > 0) handoff.next_steps = pending
  if (opts.filesModified && opts.filesModified.length > 0) handoff.files_modified = opts.filesModified

  return handoff
}

/**
 * Render a handoff as a compact "## Previous Session Context" block for
 * injection into the next session's system prompt. Sections are omitted when
 * empty to keep the local model's context lean.
 */
export function formatHandoffForPrompt(handoff: Handoff): string {
  const lines: string[] = ['## Previous Session Context']
  lines.push(`Last session goal: ${handoff.goal}`)
  lines.push(`Status: ${handoff.status}`)
  lines.push(`What was happening: ${handoff.now}`)

  const section = (label: string, arr?: string[]) => {
    if (!arr || arr.length === 0) return
    lines.push(`${label}:`)
    for (const item of arr) lines.push(`  - ${item}`)
  }

  section('Done', handoff.what_was_done)
  section('What failed', handoff.what_failed)
  section('Next steps', handoff.next_steps)
  section('Files modified', handoff.files_modified)

  return lines.join('\n')
}

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
