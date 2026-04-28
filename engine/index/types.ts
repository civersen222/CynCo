export type ChunkType = 'function' | 'class' | 'module' | 'import_block'

export type Chunk = {
  filePath: string
  chunkType: ChunkType
  name: string | null
  startLine: number
  endLine: number
  content: string
  fileHash: string
}

export type IndexResult = {
  filePath: string
  name: string | null
  chunkType: ChunkType
  startLine: number
  endLine: number
  content: string
  score: number
}

export type IndexQuery = {
  query: string
  topK?: number
  fileFilter?: string
  chunkType?: ChunkType
}

export type RelationshipType = 'imports' | 'extends' | 'uses'

export type Relationship = {
  sourceChunkId: number
  targetFile: string
  relType: RelationshipType
}
