import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { currentCounts } from './emptyCatchScan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sorted = Object.fromEntries(Object.entries(currentCounts()).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(join(here, 'emptyCatchBaseline.json'), JSON.stringify(sorted, null, 2) + '\n')
console.log(`Baseline written: ${Object.keys(sorted).length} files with empty catches`)
