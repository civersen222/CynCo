/**
 * Tool scoping filter for profile-based allow/deny lists.
 *
 * Applies ToolScoping rules to a list of tools:
 *   1. If `allowed` is defined and non-empty, only tools in that set survive.
 *   2. If `denied` is defined and non-empty, matching tools are removed.
 *   3. Both can be combined: allowed is applied first, then denied.
 *
 * Tool matching is case-sensitive on the `name` field.
 */

import type { ToolScoping } from '../profiles/types.js'

/**
 * Filter a tool array according to allow/deny scoping rules.
 *
 * @param tools  - readonly array of objects with at least a `name` field
 * @param scoping - optional ToolScoping with allowed/denied lists
 * @returns a new array containing only the tools that pass the filter
 */
export function filterTools<T extends { name: string }>(
  tools: readonly T[],
  scoping: ToolScoping | undefined,
): T[] {
  if (!scoping) return [...tools]

  let filtered = [...tools]

  // If allowed list exists, keep only those tools (empty list = no tools allowed)
  if (scoping.allowed) {
    const allowSet = new Set(scoping.allowed)
    filtered = filtered.filter(t => allowSet.has(t.name))
  }

  // If denied list exists and is non-empty, remove those tools
  if (scoping.denied && scoping.denied.length > 0) {
    const denySet = new Set(scoping.denied)
    filtered = filtered.filter(t => !denySet.has(t.name))
  }

  return filtered
}
