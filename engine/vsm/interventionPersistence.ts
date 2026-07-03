import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { InterventionTracker, InterventionCounts } from './interventionTracker.js'

const FILE = 'intervention-rates.json'

function dirFor(trainingDir?: string): string {
  return trainingDir ?? join(homedir(), '.cynco', 'training')
}

/** Absolute path to the rates file (exposed for tests). */
export function ratesPath(trainingDir?: string): string {
  return join(dirFor(trainingDir), FILE)
}

/** Load persisted success counts into the tracker. No-op if file is absent or corrupt. */
export function loadInterventionRates(tracker: InterventionTracker, trainingDir?: string): void {
  try {
    const raw = readFileSync(ratesPath(trainingDir), 'utf-8')
    const counts = JSON.parse(raw) as InterventionCounts
    if (counts && typeof counts === 'object') tracker.restore(counts)
  } catch {
    /* absent or corrupt -> keep tracker as-is */
  }
}

/** Persist the tracker's current success counts. Best-effort. */
export function saveInterventionRates(tracker: InterventionTracker, trainingDir?: string): void {
  try {
    const dir = dirFor(trainingDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE), JSON.stringify(tracker.serialize(), null, 2))
  } catch (e) {
    console.error(`[grounding] failed to persist intervention rates: ${e}`)
  }
}
