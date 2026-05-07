import { createHash } from 'crypto'
import type { Chunk } from './types.js'

export function chunkResearchReport(filePath: string, content: string): Chunk[] {
  if (!content.trim()) return []

  const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const lines = content.split('\n')
  const chunks: Chunk[] = []

  let currentHeading = ''
  let currentStart = 0
  let currentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^#{1,3}\s+(.+)/)

    if (headingMatch && currentLines.length > 0) {
      const sectionContent = currentLines.join('\n').trim()
      if (sectionContent.length > 50) {
        chunks.push({
          filePath,
          chunkType: 'research',
          name: currentHeading || null,
          startLine: currentStart + 1,
          endLine: i,
          content: sectionContent,
          fileHash,
        })
      }
      currentHeading = headingMatch[1].trim()
      currentStart = i
      currentLines = [lines[i]]
    } else {
      if (!currentHeading && headingMatch) {
        currentHeading = headingMatch[1].trim()
        currentStart = i
      }
      currentLines.push(lines[i])
    }
  }

  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n').trim()
    if (sectionContent.length > 50) {
      chunks.push({
        filePath,
        chunkType: 'research',
        name: currentHeading || null,
        startLine: currentStart + 1,
        endLine: lines.length,
        content: sectionContent,
        fileHash,
      })
    }
  }

  return chunks
}
