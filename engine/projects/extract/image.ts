/**
 * engine/projects/extract/image.ts — a photo as prose: what the image box
 * read off it. The extractor never calls the network; it is handed the look
 * (engine/vision/lookClient.ts) by `ingestFile`, so an upload's look can run
 * in the background and a rescan can reuse a recent one. Two segments: the
 * transcribed text, and the state + description. A photo with no readable
 * text still yields the description segment — never zero chunks.
 * Design: docs/decisions/2026-11-08-image-box-design.md (section 3).
 */
import type { Look } from '../../vision/lookClient.js'
import type { Segment } from './types.js'

export function imageSegments(look: Look, fileName: string): Segment[] {
  const out: Segment[] = []
  if (look.text.trim()) out.push({ heading: [fileName, 'text'], text: look.text.trim() })
  const description = [look.state.trim(), look.description.trim()].filter(Boolean).join('\n\n')
  if (description) out.push({ heading: [fileName, 'description'], text: description })
  return out
}
