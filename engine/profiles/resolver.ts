/**
 * Profile inheritance resolver for LocalCode.
 *
 * Follows `extends:` chains to merge parent profile fields into children.
 * Rules:
 *   - Child values override parent values for scalar fields
 *   - Object fields (tools, capabilities) in child replace parent entirely
 *   - Arrays replace (not union/merge)
 *   - Maximum inheritance depth of 5 (circular reference protection)
 */

import type { Profile, ResolvedProfile } from './types.js'
import { loadProfile as defaultLoadProfile } from './loader.js'

/** Maximum depth for `extends:` chain traversal. */
const MAX_DEPTH = 5

/**
 * Collect the extends chain starting from a profile, up to MAX_DEPTH.
 * Returns the chain in order: [child, parent, grandparent, ...].
 */
function collectChain(
  name: string,
  loader: (name: string) => Profile | null,
): Profile[] {
  const chain: Profile[] = []
  const visited = new Set<string>()
  let current: string | undefined = name

  for (let depth = 0; depth < MAX_DEPTH && current != null; depth++) {
    if (visited.has(current)) break  // Circular reference protection
    visited.add(current)

    const profile = loader(current)
    if (profile == null) {
      if (depth === 0) {
        // The root profile itself was not found - this is an error
        throw new Error(`Profile not found: ${name}`)
      }
      // Parent not found - stop the chain but don't error
      break
    }
    chain.push(profile)
    current = profile.extends
  }

  return chain
}

/**
 * Merge profiles from bottom (parent/ancestor) to top (child).
 * Child values override parent values.
 * Object fields (tools, capabilities) in child replace parent's entirely.
 */
function mergeChain(chain: Profile[]): ResolvedProfile {
  // Start from the deepest ancestor and layer overrides
  const merged: Record<string, unknown> = {}

  // Process from ancestor (end of chain) to child (start of chain)
  for (let i = chain.length - 1; i >= 0; i--) {
    const profile = chain[i]!
    for (const [key, value] of Object.entries(profile)) {
      if (key === 'extends') continue  // Strip extends from result
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }

  return merged as unknown as ResolvedProfile
}

/**
 * Resolve a profile by name, following its `extends:` chain.
 *
 * @param name - Profile name to resolve
 * @param loader - Optional custom loader function (useful for testing)
 * @returns Fully resolved profile with inheritance applied
 * @throws Error if the named profile is not found
 */
export function resolveProfile(
  name: string,
  loader?: (name: string) => Profile | null,
): ResolvedProfile {
  const load = loader ?? defaultLoadProfile
  const chain = collectChain(name, load)
  return mergeChain(chain)
}
