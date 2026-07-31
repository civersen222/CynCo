/**
 * YAML profile loader for LocalCode.
 *
 * Loads profile YAML files from three locations:
 *   1. .cynco/profiles/<name>.yml  (project-local, highest priority)
 *   2. ~/.cynco/profiles/<name>.yml (global)
 *   3. engine/profiles/templates/<name>.yaml (bundled, lowest priority)
 *
 * Also supports .yaml extension.
 *
 * (3) is what makes a fresh clone start. Only (1) and (2) were searched, so
 * `engine/profiles/templates/default.yaml` was a path no code read. `config.ts`
 * resolves the profile named `default` when none is given; on a machine with no
 * `~/.cynco` that returned null, `config.model` came out undefined, and
 * `main.ts` printed "No model specified. Set LOCALCODE_MODEL or use a profile."
 * and exited 1. The TUI cannot cover for it either — `build_engine_env`
 * deliberately does not forward a model, so that a stale TUI config cannot
 * silently override the engine profile. Correct, but it assumes a profile
 * exists. Every command in the README's Quick Start hit this.
 *
 * Bundled last, so a user profile of the same name always wins and the shipped
 * one is a floor rather than a ceiling.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
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
 * Get the bundled profiles directory (engine/profiles/templates/).
 *
 * Resolved from this module's own location, not from `process.cwd()`: the
 * engine is normally started from the user's project directory, which has no
 * `engine/` in it, so a cwd-relative path would be right only when the repo
 * itself is the working directory.
 */
function bundledProfilesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates')
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
 *   3. Bundled: engine/profiles/templates/<name>.yaml
 *
 * Returns null if the profile is not found or cannot be parsed.
 */
export function loadProfile(name: string): Profile | null {
  // Project-local takes priority
  const projectProfile = tryLoadFromDir(projectProfilesDir(), name)
  if (projectProfile != null) return projectProfile

  // Then global
  const globalProfile = tryLoadFromDir(globalProfilesDir(), name)
  if (globalProfile != null) return globalProfile

  // Then whatever ships with the engine, so a clone with no user config still
  // resolves a model instead of exiting 1.
  return tryLoadFromDir(bundledProfilesDir(), name)
}

/**
 * List all available profile names from all three directories.
 * Returns deduplicated names (without extensions), sorted alphabetically.
 *
 * Bundled names are included because `loadProfile` will load them: a profile the
 * engine can run on and `/model` cannot name is one the user has no way to see.
 */
export function listProfiles(): string[] {
  const names = new Set<string>()

  for (const dir of [projectProfilesDir(), globalProfilesDir(), bundledProfilesDir()]) {
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
