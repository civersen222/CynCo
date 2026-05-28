import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Manages temporary git worktrees for best-of-N sandboxing.
 *
 * Each worktree is a detached checkout from HEAD in the OS tmpdir,
 * isolated from the main workspace so parallel candidates can diverge
 * without interfering with each other or the user's working tree.
 */
export class WorktreeManager {
  private readonly repoRoot: string
  private readonly active: string[] = []

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot
  }

  /**
   * Create a detached worktree from HEAD.
   * Returns the absolute path to the new worktree directory.
   */
  async create(): Promise<string> {
    const tmpPath = mkdtempSync(join(tmpdir(), 'cynco-bestofn-'))

    // mkdtempSync creates the dir but `git worktree add` requires it NOT to exist
    // Remove the directory so git can create it itself
    rmSync(tmpPath, { recursive: true, force: true })

    this.git(`worktree add --detach "${tmpPath}"`)
    this.active.push(tmpPath)
    return tmpPath
  }

  /**
   * Remove a specific managed worktree.
   * Tries `git worktree remove --force` first; falls back to rmSync + prune.
   */
  cleanup(wtPath: string): void {
    try {
      this.git(`worktree remove --force "${wtPath}"`)
    } catch {
      // Fallback: delete the directory manually then prune the git metadata
      try {
        rmSync(wtPath, { recursive: true, force: true })
      } catch {
        // ignore — directory may already be gone
      }
      try {
        this.git('worktree prune')
      } catch {
        // ignore prune errors
      }
    }

    const idx = this.active.indexOf(wtPath)
    if (idx !== -1) this.active.splice(idx, 1)
  }

  /**
   * Remove all worktrees created by this manager instance.
   */
  cleanupAll(): void {
    // Copy the list before iterating since cleanup() mutates it
    for (const wtPath of [...this.active]) {
      this.cleanup(wtPath)
    }
  }

  /**
   * Return the list of worktree paths currently managed by this instance.
   */
  getActive(): string[] {
    return [...this.active]
  }

  // ── private ────────────────────────────────────────────────────────────

  private git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.repoRoot,
      stdio: 'pipe',
    })
      .toString()
      .trim()
  }
}
