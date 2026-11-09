/**
 * engine/vision/settings.ts — the one read site of the image box's switches.
 *
 *   LOCALCODE_VISION_URL     an Ollama base URL on the image box (the 4070 Ti
 *                            Super, http://192.168.0.47:11434). Unset = no
 *                            vision: looks are refused with "no vision model
 *                            configured" and a turn proceeds text-only.
 *   LOCALCODE_VISION_MODEL   the vision model there (default qwen3-vl:8b-instruct,
 *                            the 16 GB-class pick for reading screens).
 *
 * Set as permanent user variables on the PC, like the embedding ones, so the
 * desk engine and the headless phone engine see the same box.
 * Design: docs/decisions/2026-11-08-image-box-design.md.
 */
export type VisionSettings = { url: string | null; model: string }

export const DEFAULT_VISION_MODEL = 'qwen3-vl:8b-instruct'

export function visionSettings(env: NodeJS.ProcessEnv = process.env): VisionSettings {
  const raw = (env.LOCALCODE_VISION_URL ?? '').trim()
  const model = (env.LOCALCODE_VISION_MODEL ?? '').trim() || DEFAULT_VISION_MODEL
  return { url: raw ? raw.replace(/\/+$/, '') : null, model }
}
