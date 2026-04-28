import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Ledger, LedgerEntry } from './types.js'

const LEDGER_FILENAME = 'ledger.json'

function defaultLedger(project: string): Ledger {
  return {
    project,
    current_focus: '',
    active_streams: [],
    architecture_decisions: [],
    open_threads: [],
    session_history: [],
  }
}

export async function readLedger(dir: string, project: string): Promise<Ledger> {
  const filePath = join(dir, LEDGER_FILENAME)
  if (!existsSync(filePath)) {
    return defaultLedger(project)
  }
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as Ledger
}

export async function writeLedger(ledger: Ledger, dir: string): Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const filePath = join(dir, LEDGER_FILENAME)
  writeFileSync(filePath, JSON.stringify(ledger, null, 2) + '\n', 'utf-8')
}

export function addSessionEntry(ledger: Ledger, entry: LedgerEntry): void {
  ledger.session_history.push(entry)
  if (ledger.session_history.length > 100) {
    ledger.session_history = ledger.session_history.slice(-100)
  }
}
