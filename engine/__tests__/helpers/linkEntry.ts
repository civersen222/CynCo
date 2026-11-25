/**
 * Removing a directory link a test made, as an entry, never entering it.
 *
 * The tests make such a link with `symlinkSync(target, at, 'junction')`. On Windows that is a junction, which
 * `rmdirSync` removes as an entry. Elsewhere the type argument is ignored and the call makes a symbolic link, which
 * `rmdirSync` answers with ENOTDIR and `unlinkSync` removes as an entry (the Linux CI run of 2026-11-25: ten tests
 * failed on that rmdir, and three files' clean-ups left their links and refused to remove their folders). Neither
 * call ever enters the link, and neither removes a real folder with anything in it.
 */
import { rmdirSync, unlinkSync } from 'node:fs'

/** Removes the link at `at` as an entry: rmdir on Windows (a junction), unlink elsewhere (a symbolic link). */
export function removeLinkEntry(at: string): void {
  if (process.platform === 'win32') rmdirSync(at)
  else unlinkSync(at)
}
