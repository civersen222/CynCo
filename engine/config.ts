/**
 * LocalCode configuration loaded from LOCALCODE_* environment variables
 * and optionally from YAML profiles.
 *
 * Priority order (highest wins):
 *   1. LOCALCODE_* environment variables (explicit overrides)
 *   2. YAML profile (set via LOCALCODE_PROFILE=name)
 *   3. Built-in defaults
 */

import type { ResolvedProfile, ToolScoping } from './profiles/types.js'
import { resolveProfile } from './profiles/resolver.js'
import type { ProviderType } from './providers/factory.js'

/**
 * Detect whether we're running in local model mode.
 * Single point of truth — all local-mode guards use this.
 */
export function isLocalMode(): boolean {
  return !!(process.env.LOCALCODE_MODEL || process.env.LOCALCODE_BASE_URL)
}

export type TierSetting = 'auto' | 'basic' | 'standard' | 'advanced'

export type LocalCodeConfig = {
  baseUrl: string
  model: string | undefined
  tier: TierSetting
  expertise: 'beginner' | 'intermediate' | 'advanced'
  temperature: number
  maxOutputTokens: number
  timeout: number
  contextLength: number | undefined
  tools: ToolScoping | undefined
  contextManagement?: {
    warningThreshold: number
    hardLimit: number
  }
  provider: ProviderType
  apiKey: string
  llamaServer: string | undefined
  modelPath: string | undefined
  adapterUrl: string | undefined
  port: number
  batchSize: number
  gpuLayers: number
  flashAttn: boolean
  threads: number | undefined
  noScouts: boolean
  approveAll: boolean
}

const VALID_TIERS: TierSetting[] = ['auto', 'basic', 'standard', 'advanced']

/**
 * Load and resolve a profile if LOCALCODE_PROFILE is set.
 * Returns null if not set or profile not found.
 */
function loadProfileConfig(): ResolvedProfile | null {
  const profileName = process.env.LOCALCODE_PROFILE
  if (!profileName) return null

  try {
    return resolveProfile(profileName)
  } catch {
    // Profile not found or resolution error - continue with defaults
    return null
  }
}

/**
 * Check if a specific LOCALCODE_* env var is explicitly set (non-empty).
 */
function hasEnvVar(key: string): boolean {
  const val = process.env[key]
  return val != null && val !== ''
}

export function loadConfig(): LocalCodeConfig {
  const profile = loadProfileConfig()

  // --- tier ---
  const tierRaw = process.env.LOCALCODE_TIER ?? profile?.tier
  const tier: TierSetting = tierRaw && VALID_TIERS.includes(tierRaw as TierSetting)
    ? (tierRaw as TierSetting)
    : 'auto'

  // --- contextLength ---
  const contextLengthRaw = process.env.LOCALCODE_CONTEXT_LENGTH
  const contextLengthEnv = contextLengthRaw ? parseInt(contextLengthRaw, 10) : undefined
  const contextLength = contextLengthEnv != null && !Number.isNaN(contextLengthEnv)
    ? contextLengthEnv
    : profile?.context_length ?? undefined

  // --- baseUrl ---
  const baseUrl = hasEnvVar('LOCALCODE_BASE_URL')
    ? process.env.LOCALCODE_BASE_URL!
    : profile?.base_url ?? 'http://localhost:11434'

  // --- model ---
  const model = hasEnvVar('LOCALCODE_MODEL')
    ? process.env.LOCALCODE_MODEL!
    : profile?.model ?? undefined

  // --- temperature ---
  const temperature = hasEnvVar('LOCALCODE_TEMPERATURE')
    ? parseFloat(process.env.LOCALCODE_TEMPERATURE!)
    : profile?.temperature ?? 0.7

  // --- maxOutputTokens ---
  const maxOutputTokens = hasEnvVar('LOCALCODE_MAX_OUTPUT_TOKENS')
    ? parseInt(process.env.LOCALCODE_MAX_OUTPUT_TOKENS!, 10)
    : profile?.max_output_tokens ?? 16384

  // --- timeout ---
  const timeout = hasEnvVar('LOCALCODE_TIMEOUT')
    ? parseInt(process.env.LOCALCODE_TIMEOUT!, 10)
    : profile?.timeout ?? 300000

  // --- contextManagement ---
  const contextManagement = {
    warningThreshold: profile?.context_management?.warning_threshold ?? 0.4,
    hardLimit: profile?.context_management?.hard_limit ?? 0.8,
  }

  // --- expertise ---
  const expertise = (process.env.LOCALCODE_EXPERTISE ?? profile?.expertise ?? 'advanced') as 'beginner' | 'intermediate' | 'advanced'

  // --- provider ---
  const provider = (process.env.LOCALCODE_PROVIDER ?? 'llama-cpp') as ProviderType

  // --- apiKey ---
  const apiKey = process.env.LOCALCODE_API_KEY ?? ''

  // --- llama-cpp provider settings ---
  const llamaServer = process.env.LOCALCODE_LLAMA_SERVER || undefined
  const modelPath = process.env.LOCALCODE_MODEL_PATH || undefined
  const adapterUrl = process.env.LOCALCODE_ADAPTER_URL || undefined
  const port = parseInt(process.env.LOCALCODE_PORT ?? '8081', 10)
  const batchSize = parseInt(process.env.LOCALCODE_BATCH_SIZE ?? '2048', 10)
  const gpuLayers = parseInt(process.env.LOCALCODE_GPU_LAYERS ?? '999', 10)
  const flashAttn = (process.env.LOCALCODE_FLASH_ATTN ?? 'true') !== 'false'
  const threads = process.env.LOCALCODE_THREADS ? parseInt(process.env.LOCALCODE_THREADS, 10) : undefined

  return {
    baseUrl,
    model,
    tier,
    expertise,
    temperature,
    maxOutputTokens,
    timeout,
    contextLength,
    tools: profile?.tools,
    contextManagement,
    provider,
    apiKey,
    llamaServer,
    modelPath,
    adapterUrl,
    port,
    batchSize,
    gpuLayers,
    flashAttn,
    threads,
    noScouts: process.env.LOCALCODE_NO_SCOUTS === 'true',
    approveAll: process.env.LOCALCODE_APPROVE_ALL === 'true',
  }
}
