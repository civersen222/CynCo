// The campaign runner declares the wave's S3 terms in CYNCO_MISSION_INVARIANTS;
// the driver forwards them in the dispatch frame. Malformed => refuse the
// dispatch (exit 2), like a malformed contract sidecar: a mission that ran with
// half its orders silently dropped is the shape most likely to look like it worked.
export function invariantsFromEnv(env) {
  const raw = env.CYNCO_MISSION_INVARIANTS
  if (raw === undefined || raw === '') return null
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { throw new Error(`CYNCO_MISSION_INVARIANTS is not valid JSON — ${e.message}`) }
  for (const k of ['editGapCap', 'commitGapCap']) {
    if (typeof parsed[k] !== 'number' || !(parsed[k] > 0)) throw new Error(`CYNCO_MISSION_INVARIANTS.${k} must be a positive number`)
  }
  for (const k of ['revertBan', 'codeIndexFirst']) {
    if (typeof parsed[k] !== 'boolean') throw new Error(`CYNCO_MISSION_INVARIANTS.${k} must be a boolean`)
  }
  return { editGapCap: parsed.editGapCap, commitGapCap: parsed.commitGapCap, revertBan: parsed.revertBan, codeIndexFirst: parsed.codeIndexFirst }
}
