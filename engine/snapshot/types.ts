/** Opaque hash from git write-tree */
export type SnapshotHash = string & { __brand: 'SnapshotHash' }

export type FileStatus = 'added' | 'modified' | 'deleted'

export type FileDiff = {
  path: string
  status: FileStatus
  additions: number
  deletions: number
}

export type DiffResult = {
  files: FileDiff[]
  totalAdditions: number
  totalDeletions: number
  hasChanges: boolean
}
