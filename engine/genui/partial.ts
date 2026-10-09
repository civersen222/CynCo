/**
 * engine/genui/partial.ts — a drawable spec out of a half-streamed tool call.
 *
 * The RenderUI arguments arrive as `input_json_delta` chunks. `jsonrepair`
 * closes whatever is open (strings, arrays, objects) so the buffer parses at
 * any cut point; `validateSpec` in partial mode then keeps only what already
 * names a real component and drops the rest silently — a half-typed "Car"
 * becomes a Card on the next frame, not an error note on this one. Returns
 * null until a root element exists, so the loop emits no empty frames.
 */
import { jsonrepair } from 'jsonrepair'
import { validateSpec, isSurfaceId, type UiSpec } from './spec.js'

/** How often the loop repairs the streaming buffer into a partial frame. */
export const PARTIAL_FRAME_INTERVAL_MS = 150

export type PartialSpec = { spec: UiSpec; surface: string | null; count: number }

export function parsePartialSpec(buffer: string): PartialSpec | null {
  const trimmed = buffer.trim()
  if (trimmed.length < 2 || trimmed[0] !== '{') return null
  let parsed: unknown
  try { parsed = JSON.parse(jsonrepair(trimmed)) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const args = parsed as Record<string, unknown>
  const raw = args.spec !== undefined ? args.spec : args
  const result = validateSpec(raw, { partial: true })
  if (!result.spec) return null
  return { spec: result.spec, surface: isSurfaceId(args.surface) ? args.surface : null, count: result.count }
}
