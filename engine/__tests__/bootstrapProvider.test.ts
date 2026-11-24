/**
 * Regression: llama-cpp setup failure must be FATAL, not a silent Ollama
 * fallback. The 2026-07-02 live-session breakage: a stale model name made
 * GGUF resolution fail, the engine silently fell back to Ollama with the
 * wrong model + context budget, then every request timed out with no
 * visible cause. bootstrapProvider must throw instead.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LocalCodeConfig } from '../config.js'

vi.mock('../llama/binaryManager.js', () => ({
  resolveBinary: vi.fn(() => 'C:/fake/bin/llama-server.exe'),
  downloadBinary: vi.fn(async () => 'C:/fake/bin/llama-server.exe'),
}))

vi.mock('../llama/modelResolver.js', () => ({
  resolveModel: vi.fn(() => {
    throw new Error("No GGUF found for 'stale-model:latest'")
  }),
  resolveChatTemplateFile: vi.fn((v: string | undefined) => v),
}))

vi.mock('../llama/processManager.js', () => ({
  ProcessManager: vi.fn(),
  DEFAULT_CTX_SIZE: 65536,
}))

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn(() => ({ name: 'ollama-fallback' })),
}))

import { bootstrapProvider, binaryAction, isUnattendedMission, launchKnobs } from '../bootstrapProvider.js'
import { createProvider } from '../providers/factory.js'
import { resolveBinary, downloadBinary } from '../llama/binaryManager.js'
import { resolveModel, resolveChatTemplateFile } from '../llama/modelResolver.js'
import { ProcessManager } from '../llama/processManager.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * F161 residual (Phase 4 final review, I4): an unattended engine downloaded a
 * llama-server binary with nobody there to approve it — the live proof's second
 * launch reached GitHub and sat out the dispatch's ten-minute wait. A mission
 * refuses by name; an interactive engine keeps the download.
 */
/**
 * F233 (f), the owner's decision of 2026-11-17: for these eight knobs the profile used to beat
 * the environment, the reverse of every other setting. An exported variable was ignored
 * without a word whenever the profile named the key.
 */
describe('launchKnobs: the environment beats the profile, as it does everywhere else', () => {
  const profile = { batchSize: 512, gpuLayers: 40, flashAttn: false, cacheRam: 4096, reasoningBudget: 4096, ctxCheckpoints: 16, checkpointMinStep: 128, ubatchSize: 1024 }
  // What config.ts holds when no variable is set: the built-in defaults.
  const defaults = { batchSize: 2048, gpuLayers: 999, flashAttn: true }

  it('with no variable set, the profile is what reaches the server', () => {
    expect(launchKnobs(profile, defaults, {})).toEqual(profile)
  })

  it('with neither, the three that have a built-in default carry it and the rest are left to the server args', () => {
    expect(launchKnobs(undefined, defaults, {})).toEqual({
      batchSize: 2048, gpuLayers: 999, flashAttn: true,
      cacheRam: undefined, reasoningBudget: undefined, ctxCheckpoints: undefined, checkpointMinStep: undefined, ubatchSize: undefined,
    })
  })

  it('a variable that is set wins over the profile, each of the eight on its own', () => {
    // config.ts has already parsed these three out of the environment.
    const fromEnv = { batchSize: 256, gpuLayers: 0, flashAttn: true }
    expect(launchKnobs(profile, fromEnv, { LOCALCODE_BATCH_SIZE: '256' }).batchSize).toBe(256)
    expect(launchKnobs(profile, fromEnv, { LOCALCODE_GPU_LAYERS: '0' }).gpuLayers).toBe(0)
    expect(launchKnobs(profile, fromEnv, { LOCALCODE_FLASH_ATTN: 'true' }).flashAttn).toBe(true)
    // For the other five the field is left unset, and buildServerArgs reads the variable itself.
    expect(launchKnobs(profile, defaults, { LOCALCODE_CACHE_RAM: '9999' }).cacheRam).toBeUndefined()
    expect(launchKnobs(profile, defaults, { LOCALCODE_REASONING_BUDGET: '512' }).reasoningBudget).toBeUndefined()
    expect(launchKnobs(profile, defaults, { LOCALCODE_CTX_CHECKPOINTS: '8' }).ctxCheckpoints).toBeUndefined()
    expect(launchKnobs(profile, defaults, { LOCALCODE_CHECKPOINT_MIN_STEP: '64' }).checkpointMinStep).toBeUndefined()
    expect(launchKnobs(profile, defaults, { LOCALCODE_UBATCH_SIZE: '512' }).ubatchSize).toBeUndefined()
  })

  it('one variable moves one knob: the others stay the profile\'s', () => {
    const knobs = launchKnobs(profile, defaults, { LOCALCODE_REASONING_BUDGET: '512' })
    expect({ ...knobs, reasoningBudget: profile.reasoningBudget }).toEqual(profile)
  })

  it('an empty variable is not a setting', () => {
    expect(launchKnobs(profile, defaults, { LOCALCODE_CACHE_RAM: '', LOCALCODE_BATCH_SIZE: '' })).toEqual(profile)
  })
})

describe('binaryAction: an unattended mission refuses instead of downloading', () => {
  const dirs = { binDir: 'H/bin', brainBinDir: 'H/bin-brain' }

  it('a resolved binary is used, attended or not', () => {
    expect(binaryAction({ binaryPath: 'H/bin/llama-server.exe', unattended: true, ...dirs })).toEqual({ kind: 'use', path: 'H/bin/llama-server.exe' })
    expect(binaryAction({ binaryPath: 'H/bin/llama-server.exe', unattended: false, ...dirs })).toEqual({ kind: 'use', path: 'H/bin/llama-server.exe' })
  })

  it('no binary, interactive: download (unchanged behaviour)', () => {
    expect(binaryAction({ binaryPath: null, unattended: false, ...dirs })).toEqual({ kind: 'download' })
  })

  it('no binary, unattended: a named F161 refusal naming both directories and the override', () => {
    const a = binaryAction({ binaryPath: null, unattended: true, ...dirs })
    expect(a.kind).toBe('refuse')
    expect(a.kind === 'refuse' && a.message).toBe(
      'F161: no llama-server under H/bin or H/bin-brain; an unattended engine does not download — stage the binary or set LOCALCODE_LLAMA_SERVER')
  })

  it('isUnattendedMission reads any non-empty LOCALCODE_MISSION_* key', () => {
    expect(isUnattendedMission({})).toBe(false)
    expect(isUnattendedMission({ LOCALCODE_MISSION_CHECK: '' })).toBe(false)
    expect(isUnattendedMission({ LOCALCODE_MISSION_MARKER: 'C9_DONE' })).toBe(true)
    expect(isUnattendedMission({ LOCALCODE_MISSION_CWD: 'C:/repo', LOCALCODE_MISSION_CHECK: '' })).toBe(true)
    expect(isUnattendedMission({ LOCALCODE_MISSIONS: 'x' })).toBe(false)
  })

  it('bootstrapProvider under a mission env with no binary throws the refusal and never downloads', async () => {
    const prev = process.env.LOCALCODE_MISSION_MARKER
    process.env.LOCALCODE_MISSION_MARKER = 'F161_TEST'
    vi.mocked(resolveBinary).mockReturnValueOnce(null)
    vi.mocked(downloadBinary).mockClear()
    try {
      const config = { provider: 'llama-cpp', model: 'm', baseUrl: 'http://localhost:11434', port: 8081 } as unknown as LocalCodeConfig
      await expect(bootstrapProvider(config)).rejects.toThrow(/^F161: no llama-server under .*an unattended engine does not download/)
      expect(vi.mocked(downloadBinary)).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.LOCALCODE_MISSION_MARKER; else process.env.LOCALCODE_MISSION_MARKER = prev
    }
  })
})

describe('bootstrapProvider llama-cpp failure path', () => {
  it('throws on llama-cpp setup failure instead of falling back to Ollama', async () => {
    const config = {
      provider: 'llama-cpp',
      model: 'stale-model:latest',
      baseUrl: 'http://localhost:11434',
      port: 8081,
    } as unknown as LocalCodeConfig

    await expect(bootstrapProvider(config)).rejects.toThrow(/No GGUF found/)

    // The old bug: a silent createOllamaFallback() here. Must never happen.
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled()
  })
})

describe('bootstrapProvider: the models folder and the chat template', () => {
  const config = (over: Record<string, unknown> = {}) =>
    ({ provider: 'llama-cpp', model: 'm', baseUrl: 'http://localhost:11434', port: 8081, ...over }) as unknown as LocalCodeConfig

  async function withModelsDir(value: string | undefined, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.LOCALCODE_MODELS_DIR
    if (value === undefined) delete process.env.LOCALCODE_MODELS_DIR
    else process.env.LOCALCODE_MODELS_DIR = value
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.LOCALCODE_MODELS_DIR
      else process.env.LOCALCODE_MODELS_DIR = prev
    }
  }

  // Entry 5.M3: a missing template is a named refusal before any llama-server is started.
  it('a chat template that is not there refuses before the process manager or a slot-cache folder exists', async () => {
    const modelPath = join(tmpdir(), 'cynco-m', `no-template-${process.pid}.gguf`)
    vi.mocked(resolveModel).mockReturnValueOnce(modelPath)
    vi.mocked(resolveChatTemplateFile).mockImplementationOnce(() => {
      throw new Error("chat_template_file 'chat_template.jinja' was looked for at X and is not there.")
    })
    vi.mocked(ProcessManager).mockClear()
    vi.mocked(createProvider).mockClear()
    await expect(bootstrapProvider(config({ runtime: { chatTemplateFile: 'chat_template.jinja' } })))
      .rejects.toThrow(/chat_template_file 'chat_template\.jinja' was looked for/)
    expect(vi.mocked(resolveChatTemplateFile)).toHaveBeenLastCalledWith('chat_template.jinja', modelPath)
    expect(vi.mocked(ProcessManager)).not.toHaveBeenCalled()
    expect(existsSync(join(process.env.CYNCO_HOME!, 'slot-cache', `no-template-${process.pid}.gguf`))).toBe(false)
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled()
  })

  it('LOCALCODE_MODELS_DIR is the folder the model is looked for in', async () => {
    const moved = join(tmpdir(), 'models-elsewhere')
    await withModelsDir(moved, async () => {
      vi.mocked(resolveModel).mockClear()
      await expect(bootstrapProvider(config())).rejects.toThrow(/No GGUF found/)
      expect(vi.mocked(resolveModel).mock.lastCall?.[1]).toBe(moved)
    })
  })

  it('unset, the model is looked for under the CynCo home', async () => {
    await withModelsDir(undefined, async () => {
      vi.mocked(resolveModel).mockClear()
      await expect(bootstrapProvider(config())).rejects.toThrow(/No GGUF found/)
      expect(vi.mocked(resolveModel).mock.lastCall?.[1]).toBe(join(process.env.CYNCO_HOME!, 'models'))
    })
  })

  it('a relative value refuses before a binary or a model is looked for', async () => {
    await withModelsDir('models-here', async () => {
      vi.mocked(resolveModel).mockClear()
      vi.mocked(resolveBinary).mockClear()
      await expect(bootstrapProvider(config())).rejects.toThrow(/LOCALCODE_MODELS_DIR is "models-here", which is not an absolute path/)
      expect(vi.mocked(resolveModel)).not.toHaveBeenCalled()
      expect(vi.mocked(resolveBinary)).not.toHaveBeenCalled()
    })
  })
})
