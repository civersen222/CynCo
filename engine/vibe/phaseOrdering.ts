import { EntailmentMesh } from '../cybernetics-core/src/conversation/index.js'

export type Phase = { name: string; requires: string[]; [k: string]: unknown }

/**
 * Phase 6c: order wizard phases so every phase's prerequisites come first,
 * using Pask's EntailmentMesh (A entails B == A requires B).
 * Returns the input order on cycle detection.
 */
export function orderPhasesByEntailment(phases: Phase[]): Phase[] {
  const mesh = new EntailmentMesh()
  for (const p of phases) mesh.addTopic(p.name, p.name)
  for (const p of phases) for (const req of p.requires) mesh.addEntailment(p.name, req)

  const byName = new Map(phases.map(p => [p.name, p]))
  const done = new Set<string>()
  const out: Phase[] = []
  let progressed = true
  while (out.length < phases.length && progressed) {
    progressed = false
    for (const p of phases) {
      if (done.has(p.name)) continue
      const prereqs = mesh.allPrerequisites(p.name)
      const ready = Array.from(prereqs).every(r => !byName.has(r) || done.has(r))
      if (ready) { out.push(p); done.add(p.name); progressed = true }
    }
  }
  if (out.length < phases.length) {
    for (const p of phases) if (!done.has(p.name)) out.push(p)
  }
  return out
}
