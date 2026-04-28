
import { createHash } from 'crypto'
import type { Chunk, ChunkType } from './types.js'

/** Chunk a source file into function/class/module pieces using regex. */
export function chunkFile(filePath: string, content: string): Chunk[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const lines = content.split('\n')

  if (['py'].includes(ext)) {
    return chunkPython(filePath, lines, fileHash)
  } else if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return chunkTypeScript(filePath, lines, fileHash)
  } else {
    return chunkGeneric(filePath, lines, fileHash)
  }
}

function chunkPython(filePath: string, lines: string[], fileHash: string): Chunk[] {
  const chunks: Chunk[] = []
  let i = 0

  // Collect import block at top
  const importLines: number[] = []
  while (i < lines.length && (lines[i].startsWith('import ') || lines[i].startsWith('from ') || lines[i].trim() === '' || lines[i].startsWith('#'))) {
    if (lines[i].startsWith('import ') || lines[i].startsWith('from ')) importLines.push(i)
    i++
  }
  if (importLines.length > 0) {
    const start = importLines[0]
    const end = importLines[importLines.length - 1]
    chunks.push({
      filePath, chunkType: 'import_block', name: null,
      startLine: start + 1, endLine: end + 1,
      content: lines.slice(start, end + 1).join('\n'),
      fileHash,
    })
  }

  // Scan for def and class
  for (i = 0; i < lines.length; i++) {
    const line = lines[i]
    const defMatch = line.match(/^(\s*)def\s+(\w+)\s*\(/)
    const classMatch = line.match(/^(\s*)class\s+(\w+)/)

    if (defMatch || classMatch) {
      const isClass = !!classMatch
      const name = isClass ? classMatch![2] : defMatch![2]
      const indent = (isClass ? classMatch![1] : defMatch![1]).length
      const startLine = Math.max(0, i - 2) // Include decorator/comment
      let endLine = i + 1

      // Find end of block: next line at same or lower indent (or EOF)
      for (let j = i + 1; j < lines.length; j++) {
        const jLine = lines[j]
        if (jLine.trim() === '') { endLine = j; continue }
        const jIndent = jLine.match(/^(\s*)/)?.[1].length ?? 0
        if (jIndent <= indent && jLine.trim() !== '') {
          endLine = j
          break
        }
        endLine = j + 1
      }

      // Cap chunk size at 80 lines
      endLine = Math.min(endLine, startLine + 80)

      chunks.push({
        filePath, chunkType: isClass ? 'class' : 'function', name,
        startLine: startLine + 1, endLine,
        content: lines.slice(startLine, endLine).join('\n'),
        fileHash,
      })
    }
  }

  // If no chunks found, treat whole file as module chunk
  if (chunks.length === 0 && lines.length > 0) {
    chunks.push({
      filePath, chunkType: 'module', name: null,
      startLine: 1, endLine: Math.min(lines.length, 50),
      content: lines.slice(0, 50).join('\n'),
      fileHash,
    })
  }

  return chunks
}

function chunkTypeScript(filePath: string, lines: string[], fileHash: string): Chunk[] {
  const chunks: Chunk[] = []

  // Collect import block
  const importLines: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('import ') || lines[i].startsWith('export {')) {
      importLines.push(i)
    } else if (lines[i].trim() !== '' && !lines[i].startsWith('//') && !lines[i].startsWith('/*') && !lines[i].startsWith(' *')) {
      break
    }
  }
  if (importLines.length > 0) {
    const start = importLines[0]
    const end = importLines[importLines.length - 1]
    chunks.push({
      filePath, chunkType: 'import_block', name: null,
      startLine: start + 1, endLine: end + 1,
      content: lines.slice(start, end + 1).join('\n'),
      fileHash,
    })
  }

  // Scan for functions, classes, exports
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ||
                      line.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/)
    const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/)

    if (funcMatch || classMatch) {
      const isClass = !!classMatch
      const name = isClass ? classMatch![1] : funcMatch![1]
      const startLine = Math.max(0, i - 2)

      // Find end: matching braces
      let braceDepth = 0
      let endLine = i + 1
      let foundOpen = false
      for (let j = i; j < lines.length && j < i + 100; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceDepth++; foundOpen = true }
          if (ch === '}') braceDepth--
        }
        endLine = j + 1
        if (foundOpen && braceDepth <= 0) break
      }

      endLine = Math.min(endLine, startLine + 80)

      chunks.push({
        filePath, chunkType: isClass ? 'class' : 'function', name,
        startLine: startLine + 1, endLine,
        content: lines.slice(startLine, endLine).join('\n'),
        fileHash,
      })
    }
  }

  if (chunks.length === 0 && lines.length > 0) {
    chunks.push({
      filePath, chunkType: 'module', name: null,
      startLine: 1, endLine: Math.min(lines.length, 50),
      content: lines.slice(0, 50).join('\n'),
      fileHash,
    })
  }

  return chunks
}

function chunkGeneric(filePath: string, lines: string[], fileHash: string): Chunk[] {
  // Split at double-newline boundaries, max 50 lines per chunk
  const chunks: Chunk[] = []
  let start = 0

  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].trim() === '' && lines[i + 1]?.trim() === '') || i - start >= 50 || i === lines.length - 1) {
      if (i > start) {
        const end = Math.min(i + 1, lines.length)
        chunks.push({
          filePath, chunkType: 'module', name: null,
          startLine: start + 1, endLine: end,
          content: lines.slice(start, end).join('\n'),
          fileHash,
        })
      }
      start = i + 1
    }
  }

  if (chunks.length === 0 && lines.length > 0) {
    chunks.push({
      filePath, chunkType: 'module', name: null,
      startLine: 1, endLine: Math.min(lines.length, 50),
      content: lines.slice(0, 50).join('\n'),
      fileHash,
    })
  }

  return chunks
}

/** Extract import relationships from a chunk. */
export function extractRelationships(chunk: Chunk): { targetFile: string; relType: 'imports' | 'extends' }[] {
  const rels: { targetFile: string; relType: 'imports' | 'extends' }[] = []
  const lines = chunk.content.split('\n')

  for (const line of lines) {
    // Python: from X import Y / import X
    const pyFrom = line.match(/^from\s+(\S+)\s+import/)
    if (pyFrom) rels.push({ targetFile: pyFrom[1].replace(/\./g, '/'), relType: 'imports' })
    const pyImport = line.match(/^import\s+(\S+)/)
    if (pyImport) rels.push({ targetFile: pyImport[1].replace(/\./g, '/'), relType: 'imports' })

    // TS: import ... from './X'
    const tsImport = line.match(/from\s+['"]([^'"]+)['"]/)
    if (tsImport) rels.push({ targetFile: tsImport[1], relType: 'imports' })

    // Python: class Foo(Bar)
    const pyExtends = line.match(/class\s+\w+\(([^)]+)\)/)
    if (pyExtends) {
      for (const base of pyExtends[1].split(',')) {
        const name = base.trim()
        if (name && name !== 'object') rels.push({ targetFile: name, relType: 'extends' })
      }
    }

    // TS: extends/implements
    const tsExtends = line.match(/(?:extends|implements)\s+(\w+)/)
    if (tsExtends) rels.push({ targetFile: tsExtends[1], relType: 'extends' })
  }

  return rels
}
