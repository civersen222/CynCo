/**
 * Run the suite on the engine's defaults, whatever the launching shell exports.
 *
 * F206. The owner's shell names where this machine's services live
 * (`LOCALCODE_EMBED_BASE_URL`, `LOCALCODE_EMBED_API`, `LOCALCODE_EMBED_MODEL`,
 * `LOCALCODE_VISION_URL`, `LOCALCODE_COMFYUI_URL`, `LOCALCODE_DASHBOARD_HOST`),
 * and every test that read one of them without pinning it was red on this PC
 * and green on CI, or the reverse: `projects/bindingRunsCode.test.ts`
 * (2026-11-06), `dashboard/phoneAccess.test.ts` (2026-11-09),
 * `index/embedAutoPull.test.ts` and `index/queryUsesIndexedModel.test.ts`
 * (2026-11-11). Worse than red: with `LOCALCODE_EMBED_BASE_URL` set, tests that
 * embed were posting to the owner's live embedding service. Each was fixed, or
 * written down, one variable at a time. This clears the whole prefix once, so
 * the next variable the owner exports cannot do it again; a CI runner exports
 * none, so this is the state CI has always tested.
 *
 * A test that needs a variable sets it and restores it, as before. What is
 * kept is only what asks for MORE tests to run (`KEPT_HOST_ENV`).
 * `LOCALCODE_MISSION_*` is cleared here too; `missionEnv.ts` stays as the
 * record of why those four matter.
 */
export const KEPT_HOST_ENV: readonly string[] = ['LOCALCODE_INTEGRATION_TESTS']

export function clearHostEnv(env: Record<string, string | undefined> = process.env): void {
  for (const k of Object.keys(env)) {
    if (k.startsWith('LOCALCODE_') && !KEPT_HOST_ENV.includes(k)) delete env[k]
  }
}

clearHostEnv()
