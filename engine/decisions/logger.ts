import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type DecisionRecord = {
  timestamp: number
  userMessageSummary: string
  activeWorkflow: string | null
  contextUsagePercent: number
  toolsCalled: string[]
  toolResults: ('success' | 'failure' | 'denied')[]
  modelUsed: string
  stopReason: string
  tokenCount: number
  latencyMs: number
  userSatisfaction?: 'positive' | 'negative' | 'neutral'
}

export class DecisionLogger {
  private dir: string

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), '.cynco', 'decisions')
    mkdirSync(this.dir, { recursive: true })
  }

  log(record: DecisionRecord): void {
    const date = new Date(record.timestamp).toISOString().slice(0, 10)
    const file = join(this.dir, `${date}.jsonl`)
    appendFileSync(file, JSON.stringify(record) + '\n')
  }

  readAll(): DecisionRecord[] {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir).filter(f => f.endsWith('.jsonl')).sort()
    const records: DecisionRecord[] = []
    for (const file of files) {
      const content = readFileSync(join(this.dir, file), 'utf-8')
      for (const line of content.split('\n').filter(Boolean)) {
        records.push(JSON.parse(line))
      }
    }
    return records
  }
}
