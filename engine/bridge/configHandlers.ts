/**
 * Handlers for config/profile commands received from the TUI.
 *
 * Each handler takes the current config (mutable) and returns a response event.
 * Validators prevent invalid values from being applied.
 *
 * See spec: docs/superpowers/specs/2026-04-16-ux-completion-design.md §5.3, §5.5
 */

import type { LocalCodeConfig } from '../config.js'
import type {
  ConfigCurrentEvent,
  ConfigUpdatedEvent,
  ProfileListEvent,
  ProfileValidationEvent,
  ProfileWrittenEvent,
} from './protocol.js'

// ─── Field Validators ─────────────────────────────────────────

type FieldValidator = {
  validate: (value: unknown) => string | null  // null = valid, string = error message
  apply: (config: LocalCodeConfig, value: unknown) => void
}

const FIELD_VALIDATORS: Record<string, FieldValidator> = {
  temperature: {
    validate: (v) => {
      if (typeof v !== 'number') return 'Must be a number'
      if (v < 0 || v > 2) return 'Must be between 0 and 2'
      return null
    },
    apply: (config, v) => { config.temperature = v as number },
  },
  maxOutputTokens: {
    validate: (v) => {
      if (typeof v !== 'number') return 'Must be a number'
      if (v < 1 || v > 128000) return 'Must be between 1 and 128000'
      return null
    },
    apply: (config, v) => { config.maxOutputTokens = v as number },
  },
  timeout: {
    validate: (v) => {
      if (typeof v !== 'number') return 'Must be a number'
      if (v < 1000 || v > 600000) return 'Must be between 1000 and 600000 ms'
      return null
    },
    apply: (config, v) => { config.timeout = v as number },
  },
  contextLength: {
    validate: (v) => {
      if (typeof v !== 'number') return 'Must be a number'
      if (v < 1024 || v > 2097152) return 'Must be between 1024 and 2097152'
      return null
    },
    apply: (config, v) => { config.contextLength = v as number },
  },
  tools: {
    validate: (v) => {
      if (typeof v !== 'object' || v === null) return 'Must be an object'
      const obj = v as Record<string, unknown>
      if (obj.allowed && !Array.isArray(obj.allowed)) return 'allowed must be an array'
      if (obj.denied && !Array.isArray(obj.denied)) return 'denied must be an array'
      return null
    },
    apply: (config, v) => { config.tools = v as any },
  },
}

// ─── Handlers ─────────────────────────────────────────────────

/**
 * Return the current engine config as a protocol event.
 */
export function handleConfigGet(config: LocalCodeConfig): ConfigCurrentEvent {
  return {
    type: 'config.current',
    config: {
      model: config.model,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      timeout: config.timeout,
      baseUrl: config.baseUrl,
      contextLength: config.contextLength,
      tier: config.tier,
      tools: config.tools,
    },
  }
}

/**
 * Apply patches to the live config. Validates each field individually.
 * Returns which fields were applied and which had errors.
 */
export function handleConfigUpdate(
  config: LocalCodeConfig,
  patches: Record<string, unknown>,
): ConfigUpdatedEvent {
  const applied: Record<string, unknown> = {}
  const errors: { field: string; message: string }[] = []

  for (const [field, value] of Object.entries(patches)) {
    const validator = FIELD_VALIDATORS[field]
    if (!validator) {
      errors.push({ field, message: `Unknown config field: ${field}` })
      continue
    }
    const errorMsg = validator.validate(value)
    if (errorMsg) {
      errors.push({ field, message: errorMsg })
      continue
    }
    validator.apply(config, value)
    applied[field] = value
  }

  return {
    type: 'config.updated',
    applied,
    errors: errors.length > 0 ? errors : undefined,
  }
}

// ─── YAML Parsing Helper ──────────────────────────────────────

function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return (Bun as any).YAML.parse(input)
  }
  return (require('yaml') as typeof import('yaml')).parse(input)
}

// ─── Profile Handlers ─────────────────────────────────────────

/**
 * List all available profiles with their scope and active status.
 */
export function handleProfileList(
  activeProfileName: string | undefined,
  loader?: (name: string) => any,
  lister?: () => string[],
): ProfileListEvent {
  const listProfilesFn = lister ?? (() => {
    try {
      const { listProfiles } = require('../profiles/loader.js')
      return listProfiles()
    } catch { return [] }
  })

  const names = listProfilesFn()
  const profiles = names.map((name: string) => ({
    name,
    scope: 'user' as const,  // Simplified: full scope detection in future
    active: name === activeProfileName,
  }))

  return {
    type: 'profile.list',
    profiles,
    parseErrors: [],
  }
}

/**
 * Validate a YAML string as a profile without writing it.
 */
export function handleProfileValidate(
  yaml: string,
): ProfileValidationEvent {
  const errors: string[] = []
  try {
    const parsed = parseYaml(yaml)
    if (parsed == null || typeof parsed !== 'object') {
      errors.push('YAML did not parse to an object')
      return { type: 'profile.validation', ok: false, errors }
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      errors.push('Missing required field: name')
    }
    if (obj.temperature !== undefined) {
      const t = Number(obj.temperature)
      if (isNaN(t) || t < 0 || t > 2) errors.push('temperature must be between 0 and 2')
    }
    if (obj.max_output_tokens !== undefined) {
      const t = Number(obj.max_output_tokens)
      if (isNaN(t) || t < 1) errors.push('max_output_tokens must be positive')
    }
  } catch (err) {
    errors.push(`YAML parse error: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    type: 'profile.validation',
    ok: errors.length === 0,
    errors,
  }
}

/**
 * Validate and write a profile YAML to disk.
 * Returns ProfileWrittenEvent on success, ProfileValidationEvent on failure.
 */
export function handleProfileWrite(
  name: string,
  yaml: string,
  profilesDir?: string,
): ProfileWrittenEvent | ProfileValidationEvent {
  // Validate first
  const validation = handleProfileValidate(yaml)
  if (!validation.ok) return validation

  // Write to user profiles directory
  try {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = profilesDir ?? path.join(os.homedir(), '.cynco', 'profiles')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${name}.yml`)
    fs.writeFileSync(filePath, yaml, 'utf-8')
    return { type: 'profile.written', name, path: filePath }
  } catch (err) {
    return {
      type: 'profile.validation',
      ok: false,
      errors: [`Write failed: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}
