import { execFileSync } from 'node:child_process'

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** Clone `srcRepo` into `destDir` (must be empty/new) with a real working tree. */
export function cloneRepo(srcRepo: string, destDir: string): void {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', srcRepo, destDir], { stdio: 'pipe' })
}

/** Detach-checkout the given ref inside an existing clone. */
export function checkoutRef(dir: string, ref: string): void {
  git(dir, ['checkout', '--quiet', ref])
}

/** Apply a patch file to the working tree of an existing clone. */
export function applyPatch(dir: string, patchFile: string): void {
  git(dir, ['apply', patchFile])
}
