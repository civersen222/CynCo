/**
 * Run the suite as an INTERACTIVE engine, whatever environment launched it.
 *
 * Phase 5 Task 1 made S5 legacy authority read `advisory` when any
 * `LOCALCODE_MISSION_*` key is set (`engine/missionEnv.ts`). A mission engine
 * is launched with all four (`scripts/dispatch-mission.sh`) and every Bash /
 * contract-verify child inherits them, so a mission that runs this suite as its
 * check command would see tests that expect `legacy` go red over ambient state
 * — the F58 hazard in another form. Tests that need a mission env set the keys
 * themselves and restore them (missionEnv, ruleAuthorityUnattended,
 * s5DispatchRefusal, bootstrapProvider).
 */
import { MISSION_ENV_KEYS } from '../../missionEnv.js'

for (const k of MISSION_ENV_KEYS) delete process.env[k]
