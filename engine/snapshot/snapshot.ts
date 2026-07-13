import { execSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
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

  /**
   * Ensure `entry` is present in `<gitDir>/info/exclude` without overwriting
   * any lines that are already there.  Creates the file (and its parent dir)
   * if they don't yet exist.
   */
  private ensureExcludeEntry(entry: string): void {
    const excludeDir = join(this.gitDir, 'info')
    const excludeFile = join(excludeDir, 'exclude')
    if (!existsSync(excludeDir)) {
      mkdirSync(excludeDir, { recursive: true })
    }
    let existing = ''
    try { existing = readFileSync(excludeFile, 'utf-8') } catch { /* will create */ }
    const lines = new Set(existing.split('\n').map(l => l.trim()).filter(Boolean))
    if (!lines.has(entry)) {
      const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
      writeFileSync(excludeFile, existing + sep + entry + '\n')
    }
  }

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

  // ── private helpers ────────────────────────────────────────────────────

  /**
   * Parse stderr/message text from a failed `git add -A` to extract paths of
   * embedded git repos, add them to info/exclude, and drop any gitlinks already
   * staged. Returns true if at least one path was excluded (caller should retry).
   */
  private excludeEmbeddedRepos(errText: string): boolean {
    const paths = new Set<string>()

    // Pattern: error: 'foo/' does not have a commit checked out
    const noCommitRe = /error: '(.+?)' does not have a commit checked out/g
    let m: RegExpExecArray | null
    while ((m = noCommitRe.exec(errText)) !== null) {
      paths.add(m[1].replace(/\\/g, '/').replace(/\/$/, ''))
    }

    // Pattern: warning: adding embedded git repository: foo
    const embeddedRe = /warning: adding embedded git repository: (.+)/g
    while ((m = embeddedRe.exec(errText)) !== null) {
      paths.add(m[1].trim().replace(/\\/g, '/').replace(/\/$/, ''))
    }

    if (paths.size === 0) return false

    // Read existing exclude file so we can deduplicate
    const excludeFile = join(this.gitDir, 'info', 'exclude')
    let existing = ''
    try { existing = readFileSync(excludeFile, 'utf-8') } catch { /* will create */ }

    const existingLines = new Set(existing.split('\n').map(l => l.trim()).filter(Boolean))

    const toAppend: string[] = []
    for (const p of paths) {
      const entry = p.endsWith('/') ? p : `${p}/`
      if (!existingLines.has(entry)) {
        toAppend.push(entry)
        existingLines.add(entry)
      }
    }

    if (toAppend.length > 0) {
      const newContent = existing.endsWith('\n') || existing === ''
        ? existing + toAppend.join('\n') + '\n'
        : existing + '\n' + toAppend.join('\n') + '\n'
      writeFileSync(excludeFile, newContent)
    }

    // Drop any gitlinks already staged (ignore failures — may not be in index yet)
    for (const p of paths) {
      try {
        this.git(`rm -r --cached --ignore-unmatch -- "${p}"`)
      } catch {
        // ignore
      }
    }

    return true
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
      this.ensureExcludeEntry('.cynco-snapshots')
    }
  }

  /**
   * Stage every file in the workspace and write a tree object.
   * Returns the tree hash — a content-addressable snapshot of the workspace.
   * Auto-initializes the repo if needed (handles "not a git repository" errors).
   */
  track(): SnapshotHash {
    try {
      try {
        this.git('add -A')
      } catch (addErr) {
        // Check if the failure is due to embedded git repos
        const errText = (() => {
          if (addErr instanceof Error) {
            const asAny = addErr as any
            const stderr = asAny.stderr instanceof Buffer
              ? asAny.stderr.toString()
              : typeof asAny.stderr === 'string' ? asAny.stderr : ''
            return addErr.message + '\n' + stderr
          }
          return String(addErr)
        })()

        if (this.excludeEmbeddedRepos(errText)) {
          // Retry once after excluding embedded repos
          this.git('add -A')
        } else {
          // Unrelated failure — let outer catch handle it
          throw addErr
        }
      }
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
          this.ensureExcludeEntry('.cynco-snapshots')
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
