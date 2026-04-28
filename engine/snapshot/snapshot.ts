import { execSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SnapshotHash, DiffResult, FileDiff, FileStatus } from './types.js'

/**
 * Git-based workspace snapshot system.
 *
 * Creates a separate bare git repo inside `.cynco-snapshots/` so snapshots
 * never interfere with any user-level git repo in the workspace.  All git
 * commands are executed with `GIT_DIR` / `GIT_WORK_TREE` pointed at the
 * snapshot repo and the workspace respectively.
 */
export class WorkspaceSnapshot {
  private readonly workDir: string
  private readonly gitDir: string

  constructor(workDir: string) {
    this.workDir = workDir
    this.gitDir = join(workDir, '.cynco-snapshots')
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Common env vars that redirect git to our snapshot repo. */
  private env(): Record<string, string> {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workDir,
    } as Record<string, string>
  }

  /** Run a git command inside the snapshot repo context. */
  private git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.workDir,
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim()
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Initialise the snapshot repository.
   * Safe to call multiple times — creates or repairs the repo as needed.
   */
  init(): void {
    const headPath = join(this.gitDir, 'HEAD')
    const needsInit = !existsSync(this.gitDir) || !existsSync(headPath)

    if (needsInit) {
      mkdirSync(this.gitDir, { recursive: true })
      // --bare keeps things lightweight — no working tree inside the snapshot dir
      execSync(`git init --bare "${this.gitDir}"`, {
        cwd: this.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // Exclude the snapshot repo itself from being tracked
      const excludeDir = join(this.gitDir, 'info')
      if (!existsSync(excludeDir)) {
        mkdirSync(excludeDir, { recursive: true })
      }
      writeFileSync(join(excludeDir, 'exclude'), '.cynco-snapshots\n')
    }
  }

  /**
   * Stage every file in the workspace and write a tree object.
   * Returns the tree hash — a content-addressable snapshot of the workspace.
   * Auto-initializes the repo if needed (handles "not a git repository" errors).
   */
  track(): SnapshotHash {
    try {
      this.git('add -A')
      const hash = this.git('write-tree')
      return hash as SnapshotHash
    } catch (e) {
      // If git commands fail (e.g., repo corrupted or not initialized), re-init and retry
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('not a git repository') || msg.includes('fatal')) {
        console.log(`[snapshot] Git error, re-initializing: ${msg.slice(0, 100)}`)
        // Force re-init by removing the check
        try {
          execSync(`git init --bare "${this.gitDir}"`, {
            cwd: this.workDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          const excludeDir = join(this.gitDir, 'info')
          mkdirSync(excludeDir, { recursive: true })
          writeFileSync(join(excludeDir, 'exclude'), '.cynco-snapshots\n')
          // Retry
          this.git('add -A')
          const hash = this.git('write-tree')
          return hash as SnapshotHash
        } catch (retryErr) {
          console.log(`[snapshot] Re-init failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
          throw retryErr
        }
      }
      throw e
    }
  }

  /**
   * Compute a structured diff between two snapshots.
   *
   * Uses `git diff-tree -r --numstat` which outputs lines of the form:
   *   additions\tdeletions\tpath
   *
   * Binary files show `-` for additions/deletions — we record them as 0.
   */
  diff(from: SnapshotHash, to: SnapshotHash): DiffResult {
    if (from === to) {
      return { files: [], totalAdditions: 0, totalDeletions: 0, hasChanges: false }
    }

    try {
      const raw = this.git(`diff-tree -r --numstat ${from} ${to}`)
      if (!raw) {
        return { files: [], totalAdditions: 0, totalDeletions: 0, hasChanges: false }
      }

      let totalAdditions = 0
      let totalDeletions = 0
      const files: FileDiff[] = []

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length < 3) continue

        const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
        const path = parts.slice(2).join('\t') // handles paths with tabs (unlikely but safe)

        // Determine status by looking at additions/deletions heuristic,
        // but diff-tree --numstat doesn't directly say added/modified/deleted.
        // We need --diff-filter or a second pass.  Instead, use diff-tree
        // with --name-status in a separate call for accuracy.
        let status: FileStatus = 'modified'
        // We'll fix status below after a --name-status pass.

        files.push({ path, status, additions, deletions })
        totalAdditions += additions
        totalDeletions += deletions
      }

      // Second pass: get accurate status letters
      try {
        const statusRaw = this.git(`diff-tree -r --name-status ${from} ${to}`)
        const statusMap = new Map<string, FileStatus>()
        for (const line of statusRaw.split('\n')) {
          if (!line.trim()) continue
          const tab = line.indexOf('\t')
          if (tab === -1) continue
          const letter = line.slice(0, tab).trim()
          const filePath = line.slice(tab + 1).trim()
          if (letter === 'A') statusMap.set(filePath, 'added')
          else if (letter === 'D') statusMap.set(filePath, 'deleted')
          else statusMap.set(filePath, 'modified')
        }
        for (const f of files) {
          f.status = statusMap.get(f.path) ?? f.status
        }
      } catch {
        // status pass failed — keep 'modified' defaults
      }

      return {
        files,
        totalAdditions,
        totalDeletions,
        hasChanges: files.length > 0,
      }
    } catch {
      return { files: [], totalAdditions: 0, totalDeletions: 0, hasChanges: false }
    }
  }

  /**
   * Restore the workspace to the state captured in a snapshot.
   *
   * 1. `git read-tree <hash>` — point the index at the snapshot tree
   * 2. `git checkout-index -a -f` — overwrite workspace files from the index
   * 3. Delete files that exist on disk but aren't in the snapshot
   */
  restore(hash: SnapshotHash): void {
    // Point index at the target tree
    this.git(`read-tree ${hash}`)

    // Force-checkout all files from the index
    this.git('checkout-index -a -f')

    // Remove files that weren't part of the snapshot
    try {
      const extras = this.git('ls-files --others --exclude-standard')
      if (extras) {
        for (const relPath of extras.split('\n')) {
          if (!relPath.trim()) continue
          const absPath = join(this.workDir, relPath.trim())
          try {
            unlinkSync(absPath)
          } catch {
            // file may already be gone — ignore
          }
        }
      }
    } catch {
      // ls-files failed — best-effort restore already done
    }
  }
}
