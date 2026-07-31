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
import type { ProviderType } from '../providers/factory.js'

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
 * llama-cpp launch parameters. Snake_case keys mirror the YAML profile.
 * Each key is the design source for a ServerConfig field in engine/llama/processManager.ts.
 * All optional — omitted keys keep the built-in launch defaults.
 */
export type ProfileRuntime = {
  spec_type?: string
  spec_draft_n?: number
  gpu_layers?: number
  batch_size?: number
  flash_attn?: boolean
  cache_ram?: number
  reasoning_budget?: number
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
  model_file?: string
  runtime?: ProfileRuntime
  tier?: TierSetting
  /**
   * Which provider to drive. Every other field here follows env > profile >
   * built-in default; this one did not exist, so provider selection was
   * env-or-`llama-cpp` and nothing else. The README's Ollama Quick Start sets
   * no env at all, so it booted the llama.cpp direct provider and went looking
   * for a GGUF, while the config table said the default was `ollama`.
   *
   * The built-in default stays `llama-cpp`, so a setup that relies on it is
   * unaffected. The profile that ships with the engine names `ollama`, which
   * is the path the Quick Start documents.
   */
  provider?: ProviderType
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
