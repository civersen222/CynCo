import type { Extracted, Extractor, Segment } from './types.js'

/** `.md`/`.markdown`: heading path from ATX `#`–`###`; `.txt`: one segment under the file name. */
export const extractMarkdown: Extractor = async (bytes, fileName) => {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.trim()) return { ok: false, reason: 'empty file' }
  if (!/\.(md|markdown)$/i.test(fileName)) return { ok: true, segments: [{ heading: [fileName], text: text.trim() }] }
  const segments: Segment[] = []
  const path: string[] = []
  let buf: string[] = []
  let heading: string[] = [fileName]
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) segments.push({ heading: [...heading], text: t })
    buf = []
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/)
    if (m) {
      flush()
      const level = m[1].length
      path.length = level - 1
      path[level - 1] = m[2].trim()
      heading = [...path].filter(Boolean)
      continue
    }
    buf.push(line)
  }
  flush()
  return { ok: true, segments }
}
