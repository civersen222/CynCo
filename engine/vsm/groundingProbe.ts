/**
 * Grounding probe — concept-collision detector.
 *
 * Empirical motivation (deepdive on city-yield-consumers, N=4/arm): every run
 * that drove production from a *non-authoritative* happiness symbol failed the
 * happiness assertion (6/6), while the run that used the authoritative
 * `happiness_system` API passed. The failures are NOT hallucinated symbols —
 * `self.happiness` genuinely exists. They are CONCEPT-COLLISION errors: a
 * concept is defined in several places and the agent committed to the wrong one.
 *
 * This probe detects that class of error statically, from the repo's symbol
 * table + a proposed edit, with no model and no test execution.
 */

export interface ConceptInfo {
  /** files where a plain `self.<concept>` field is defined */
  plainFields: string[]
  /** the authoritative source token for this concept, e.g. `happiness_system` */
  systemSource: string
}

/** A concept is "multi-source" (collision-prone) when it has BOTH a plain
 *  `self.<c>` field AND a dedicated `<c>_system` source (attribute or module). */
export type ConceptTable = Map<string, ConceptInfo>

const SELF_FIELD_DEF = /self\.([a-zA-Z_]\w*)\s*[:=]/g

export function buildConceptTable(files: { path: string; content: string }[]): ConceptTable {
  const plainFieldFiles = new Map<string, Set<string>>()
  const systemTokens = new Set<string>()

  for (const f of files) {
    const base = f.path.replace(/\\/g, '/').split('/').pop() ?? ''
    if (/_system\.py$/.test(base)) systemTokens.add(base.replace(/\.py$/, ''))

    for (const m of f.content.matchAll(SELF_FIELD_DEF)) {
      const name = m[1]
      const after = f.content.slice(m.index! + m[0].length, m.index! + m[0].length + 1)
      if (after === '=') continue // this was `==`
      if (/_system$/.test(name)) {
        systemTokens.add(name)
      } else {
        if (!plainFieldFiles.has(name)) plainFieldFiles.set(name, new Set())
        plainFieldFiles.get(name)!.add(f.path)
      }
    }
  }

  const table: ConceptTable = new Map()
  for (const [concept, fileSet] of plainFieldFiles) {
    const sys = `${concept}_system`
    if (systemTokens.has(sys)) {
      table.set(concept, { plainFields: [...fileSet], systemSource: sys })
    }
  }
  return table
}

export interface GroundingFinding {
  concept: string
  usedPlainField: boolean
  usedSystemSource: boolean
  systemSource: string
}

export function probeEdit(addedLines: string[], table: ConceptTable): GroundingFinding[] {
  const text = addedLines.join('\n')
  const findings: GroundingFinding[] = []
  for (const [concept, info] of table) {
    const plainRe = new RegExp(`\\b${concept}(?!_system)\\b`)
    const sysRe = new RegExp(`\\b${info.systemSource}\\b`)
    const usedPlain = plainRe.test(text)
    const usedSystem = sysRe.test(text)
    if (usedPlain && !usedSystem) {
      findings.push({ concept, usedPlainField: true, usedSystemSource: false, systemSource: info.systemSource })
    }
  }
  return findings
}

export function isGrounded(addedLines: string[], table: ConceptTable): boolean {
  return probeEdit(addedLines, table).length === 0
}
