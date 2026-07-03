/**
 * Grounding probe (prototype).
 *
 * Empirical motivation (deepdive on city-yield-consumers, N=4/arm): every run
 * that drove production from a *non-authoritative* happiness symbol failed the
 * happiness assertion (6/6), while the run that used the authoritative
 * `happiness_system` API passed. The failures are NOT hallucinated symbols —
 * `self.happiness` genuinely exists (city.py and game.py both define it). They
 * are CONCEPT-COLLISION errors: a concept ("happiness") is defined in several
 * places, and the agent committed to the wrong one without disambiguating.
 *
 * This probe detects that class of error statically, from the repo's symbol
 * table + a proposed edit, with no model and no test execution. It is the
 * candidate "when to fire" signal for governance: fire a verify-the-source nudge
 * the moment an edit resolves a multi-source concept to a non-authoritative field.
 *
 * Scope note: this is a deliberately narrow, falsifiable prototype, not the
 * finished intervention. It catches the dominant failure cluster on this task;
 * it cannot catch unrelated whole-function collapses, and "authoritative ==
 * the `*_system` source" is a heuristic, not a proof.
 */

export interface ConceptInfo {
  /** files where a plain `self.<concept>` field is defined */
  plainFields: string[]
  /** the authoritative source token for this concept, e.g. `happiness_system` */
  systemSource: string
}

/** A concept is "multi-source" (collision-prone) when it has BOTH a plain
 *  `self.<c>` field AND a dedicated `<c>_system` source (attribute or module).
 *  Those are exactly the concepts where picking the wrong symbol silently
 *  compiles but reads the wrong value. */
export type ConceptTable = Map<string, ConceptInfo>

const SELF_FIELD_DEF = /self\.([a-zA-Z_]\w*)\s*[:=]/g

/**
 * Build the collision table from the repo's source files. We look for concept
 * tokens C such that:
 *   - `self.C` is defined as a plain field somewhere, AND
 *   - an authoritative source `C_system` exists, either as a `self.C_system`
 *     attribute or as a `C_system.py` module.
 */
export function buildConceptTable(files: { path: string; content: string }[]): ConceptTable {
  const plainFieldFiles = new Map<string, Set<string>>() // concept -> files defining self.<concept>
  const systemTokens = new Set<string>() // e.g. "happiness_system"

  for (const f of files) {
    // module-based system sources: happiness_system.py -> "happiness_system"
    const base = f.path.replace(/\\/g, '/').split('/').pop() ?? ''
    if (/_system\.py$/.test(base)) systemTokens.add(base.replace(/\.py$/, ''))

    for (const m of f.content.matchAll(SELF_FIELD_DEF)) {
      const name = m[1]
      // assignment, not a comparison (== is excluded by the [:=] class already,
      // but guard `self.x == y` style by rejecting a following '=')
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
  /** the plain field the edit committed to, e.g. "self.happiness" */
  usedPlainField: boolean
  /** whether the edit referenced the authoritative `<concept>_system` source */
  usedSystemSource: boolean
  systemSource: string
}

/**
 * Probe a proposed edit (its added lines) against the concept table. For every
 * multi-source concept the edit *uses* via its plain field but never via the
 * authoritative `<concept>_system` source, return a finding. An empty result
 * means "grounded" (no collision-prone concept resolved to the wrong source).
 */
export function probeEdit(addedLines: string[], table: ConceptTable): GroundingFinding[] {
  const text = addedLines.join('\n')
  const findings: GroundingFinding[] = []
  for (const [concept, info] of table) {
    // plain-field use: `self.<concept>` or `.<concept>` NOT followed by `_system`
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

/** Convenience: an edit is grounded iff the probe finds no wrong-source use. */
export function isGrounded(addedLines: string[], table: ConceptTable): boolean {
  return probeEdit(addedLines, table).length === 0
}
