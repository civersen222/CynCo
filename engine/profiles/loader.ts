/**
 * YAML profile loader for LocalCode.
 *
 * Loads profile YAML files from two locations:
 *   1. .cynco/profiles/<name>.yml  (project-local, higher priority)
 *   2. ~/.cynco/profiles/<name>.yml (global, lower priority)
 *
 * Also supports .yaml extension.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Profile } from './types.js'

/** Parse YAML using Bun's built-in parser, with npm `yaml` fallback. */
function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return (Bun as any).YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}

/** Extensions to search for profile files, in priority order. */
const PROFILE_EXTENSIONS = ['.yml', '.yaml']

/**
 * Get the user's home directory.
 * Reads process.env.HOME directly (reactive to changes) with os.homedir() fallback.
 * Note: Bun caches os.homedir() at startup, so env var read is needed for testability.
 */
function homeDir(): string {
  return process.env.HOME ?? os.homedir()
}

/**
 * Get the global profiles directory (~/.cynco/profiles/).
 */
function globalProfilesDir(): string {
  return path.join(homeDir(), '.cynco', 'profiles')
}

/**
 * Get the project-local profiles directory (.cynco/profiles/).
 * Relative to cwd.
 */
function projectProfilesDir(): string {
  return path.join(process.cwd(), '.cynco', 'profiles')
}

/**
 * Attempt to read and parse a profile YAML file at the given directory.
 * Tries .yml first, then .yaml.
 * Returns null if not found or parse fails.
 */
function tryLoadFromDir(dir: string, name: string): Profile | null {
  for (const ext of PROFILE_EXTENSIONS) {
    const filePath = path.join(dir, `${name}${ext}`)
    try {
      if (!fs.existsSync(filePath)) continue
      const content = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseYaml(content)
      if (parsed == null || typeof parsed !== 'object') return null
      // Basic shape validation: must have a name field
      const obj = parsed as Record<string, unknown>
      if (typeof obj.name !== 'string') return null
      return obj as unknown as Profile
    } catch {
      // Malformed YAML or read error
      return null
    }
  }
  return null
}

/**
 * Load a profile by name.
 *
 * Search order:
 *   1. Project-local: .cynco/profiles/<name>.yml (.yaml)
 *   2. Global: ~/.cynco/profiles/<name>.yml (.yaml)
 *
 * Returns null if the profile is not found or cannot be parsed.
 */
export function loadProfile(name: string): Profile | null {
  // Project-local takes priority
  const projectProfile = tryLoadFromDir(projectProfilesDir(), name)
  if (projectProfile != null) return projectProfile

  // Fall back to global
  const globalProfile = tryLoadFromDir(globalProfilesDir(), name)
  if (globalProfile != null) return globalProfile

  return null
}

/**
 * List all available profile names from both directories.
 * Returns deduplicated names (without extensions), sorted alphabetically.
 */
export function listProfiles(): string[] {
  const names = new Set<string>()

  for (const dir of [projectProfilesDir(), globalProfilesDir()]) {
    try {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir)
      for (const file of files) {
        for (const ext of PROFILE_EXTENSIONS) {
          if (file.endsWith(ext)) {
            names.add(file.slice(0, -ext.length))
          }
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }

  return Array.from(names).sort()
}
