/**
 * engine/print3d/check.ts — the operator's live check of MakeModel with the
 * real programs on this PC:
 *
 *   bun engine/print3d/check.ts [design.scad] [--slice] [--material ASA] [--quality fine]
 *
 * Says which OpenSCAD and Bambu Studio it found, makes a throwaway project in
 * the temp folder, copies the design in as models/<name>.scad (a 20 mm
 * calibration cube with a 3.2 mm hole when none is given), builds it the way
 * a project chat's MakeModel call does, prints the tool's answer and leaves
 * the folder for a look (its path is the last line). Nothing here touches a
 * real project or the printer.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createProject } from '../projects/layout.js'
import { defaultDeps, makeModel } from './build.js'
import { findOpenScad } from './openscad.js'
import { findBambuStudio, QUALITIES, type Quality } from './slicer.js'

const SAMPLE = `// A 20 mm calibration cube with an M3 clearance hole through it.
size = 20;     // mm
hole_d = 3.2;  // M3 clearance
difference() {
  cube(size);
  translate([size / 2, size / 2, -1]) cylinder(d = hole_d, h = size + 2, $fn = 48);
}
`

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const slice = args.includes('--slice'); if (slice) args.splice(args.indexOf('--slice'), 1)
const material = flag('--material')
const quality = flag('--quality')
if (quality !== undefined && !(QUALITIES as readonly string[]).includes(quality)) { console.log(`--quality must be one of ${QUALITIES.join(', ')}`); process.exit(2) }
const design = args[0]

console.log(`OpenSCAD:      ${findOpenScad() ?? 'not found'}`)
const bambu = findBambuStudio()
console.log(`Bambu Studio:  ${bambu ? bambu.program : 'not found'}`)

const home = mkdtempSync(join(tmpdir(), 'cynco-print3d-check-'))
const { slug } = createProject(home, { name: 'Print check' })
const dir = join(home, slug)
mkdirSync(join(dir, 'models'), { recursive: true })
const name = design ? basename(design) : 'calibration-cube.scad'
if (design) copyFileSync(design, join(dir, 'models', name)); else writeFileSync(join(dir, 'models', name), SAMPLE)

const started = Date.now()
const r = await makeModel(dir, { file: `models/${name}`, slice, ...(material ? { material } : {}), ...(quality ? { quality: quality as Quality } : {}) }, defaultDeps)
console.log(`\n${r.text}\n`)
console.log(`${r.ok ? 'OK' : 'NOT OK'} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
console.log(`Project folder: ${dir}`)
process.exit(r.ok ? 0 : 1)
