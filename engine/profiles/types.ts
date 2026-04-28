/**
 * YAML profile type definitions for LocalCode.
 *
 * Profiles allow users to configure model settings via YAML files stored in:
 *   - ~/.cynco/profiles/   (global)
 *   - .cynco/profiles/     (project-local, higher priority)
 *
 * Profiles support inheritance via `extends:` for composable configurations.
 */

import type { TierSetting } from '../config.js'

/** Tool allow/deny scoping. Both fields are optional. */
export type ToolScoping = {
  allowed?: string[]
  denied?: string[]
}

/** Capability overrides for models with varying feature support. */
export type CapabilityOverrides = {
  tool_use?: 'native' | 'simulated' | 'none'
  thinking?: 'native' | 'simulated' | 'none'
  vision?: boolean
}

/**
 * Raw profile as loaded from a YAML file.
 * May contain an `extends` field referencing a parent profile.
 */
export type Profile = {
  name: string
  extends?: string
  model?: string
  temperature?: number
  max_output_tokens?: number
  context_length?: number
  tier?: TierSetting
  base_url?: string
  timeout?: number
  system_prompt_append?: string
  tools?: ToolScoping
  capabilities?: CapabilityOverrides
  context_management?: {
    warning_threshold?: number
    hard_limit?: number
  }
}

/**
 * A fully resolved profile with inheritance applied.
 * The `extends` field is removed after resolution.
 */
export type ResolvedProfile = Required<Pick<Profile, 'name'>> & Omit<Profile, 'extends'>
