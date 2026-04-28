import { readdirSync } from 'fs'
import { join } from 'path'
import type { Handoff, Ledger } from './types.js'
import { readLedger, writeLedger, addSessionEntry } from './ledger.js'
import { writeHandoff, readHandoff } from './handoff.js'

const HANDOFFS_DIR = 'handoffs'

export type SessionStartState = {
  ledger: Ledger
  recentHandoffs: { path: string; handoff: Handoff }[]
}

export async function onSessionStart(baseDir: string, project: string): Promise<SessionStartState> {
  const ledger = await readLedger(baseDir, project)
  const handoffsDir = join(baseDir, HANDOFFS_DIR)

  let recentHandoffs: { path: string; handoff: Handoff }[] = []
  try {
    const files = readdirSync(handoffsDir)
      .filter(f => f.endsWith('.yml'))
      .sort()
      .slice(-5)

    recentHandoffs = await Promise.all(
      files.map(async f => {
        const path = join(handoffsDir, f)
        const handoff = await readHandoff(path)
        return { path, handoff }
      })
    )
  } catch {
    // Directory doesn't exist yet
  }

  return { ledger, recentHandoffs }
}

export async function onSessionEnd(
  baseDir: string,
  project: string,
  handoff: Handoff,
): Promise<string> {
  const handoffsDir = join(baseDir, HANDOFFS_DIR)
  const topic = handoff.goal.slice(0, 50).replace(/\s+/g, '-').toLowerCase()
  const filePath = await writeHandoff(handoff, handoffsDir, topic)

  const ledger = await readLedger(baseDir, project)
  ledger.current_focus = handoff.now
  addSessionEntry(ledger, {
    date: new Date().toISOString().slice(0, 10),
    focus: handoff.goal,
    handoff: filePath.split('/').pop(),
  })
  await writeLedger(ledger, baseDir)

  return filePath
}
