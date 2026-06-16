# Unified Runtime Config via Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one profile file fully describe the runtime so the daemon, TUI, and manual launches all resolve the same model, quant, context window, and MTP config — and cannot silently diverge.

**Architecture:** Extend the YAML `Profile` schema with an exact `model_file` and a `runtime` launch block; harden `modelResolver` so it never "picks the largest gguf"; thread `model_file` + `runtime.*` through `config.ts` → `main.ts` → `ProcessManager`; add a canonical `~/.cynco/profiles/default.yaml` that auto-loads when `LOCALCODE_PROFILE` is unset; rename the messy model folders and strip the divergent hardcoded launch args from the TUI and the daemon docs.

**Tech Stack:** TypeScript (Bun runtime), `bun:test` for unit tests run under `npx vitest run`, Python (Textual TUI), YAML profiles.

**Spec:** `docs/superpowers/specs/2026-06-13-unified-runtime-config-design.md`

**Precedence (unchanged, one new tier):**
```
env (LOCALCODE_*)  >  LOCALCODE_PROFILE profile  >  default.yaml (if present)  >  built-in defaults
```

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `engine/profiles/types.ts` | Profile schema | Add `model_file?` + `runtime?: ProfileRuntime` |
| `engine/llama/modelResolver.ts` | gguf path resolution | Add `modelFile` arg; error on multi-gguf instead of pick-largest |
| `engine/llama/processManager.ts` | llama-server launch args | Add `cacheRam`/`reasoningBudget` to `ServerConfig` + `ProcessManagerConfig` |
| `engine/config.ts` | Config merge + precedence | Add `RuntimeConfig`, `modelFile`/`runtime` fields; map profile runtime; auto-load `default` profile |
| `engine/main.ts` | Wiring | Pass `config.modelFile` to `resolveModel`; build `ProcessManager` from `config.runtime` |
| `engine/profiles/templates/default.yaml` | Repo template (git) | Create |
| `~/.cynco/profiles/default.yaml` | Live canonical profile | Create from template |
| `~/.cynco/models/qwen3.6-mtp/` → `qwen3.6-27b-q6k/` | Model dir | Rename |
| `~/.cynco/models/qwen3.6/` → `qwen3.6-35b-a3b-q4km/` | Retired model dir | Rename (kept) |
| `tui/localcode_tui/screens/project_picker.py` | TUI launcher | Drop hardcoded `gemma4:31b`/`65536` fallbacks |
| `docs/liveness-setup.md` | Daemon launch docs | Drop `LOCALCODE_MODEL=qwen3.6` |

**Test commands:** single file during dev — `bun test <path>`; full suite for the baseline gate — `npx vitest run`. The current green baseline is commit `cf75f8e` (0 failures).

---

### Task 1: Extend Profile schema with `model_file` + `runtime` block

**Files:**
- Modify: `engine/profiles/types.ts`
- Test: `engine/__tests__/profiles/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `engine/__tests__/profiles/resolver.test.ts`, inside the `describe('resolveProfile', ...)` block:

```typescript
  it('carries model_file and runtime block through resolution', () => {
    const profiles: Record<string, Profile> = {
      'rt': {
        name: 'rt',
        model: 'qwen3.6-27b-q6k',
        model_file: 'Qwen3.6-27B-Q6_K.gguf',
        runtime: { spec_type: 'mtp', spec_draft_n: 3, gpu_layers: 999 },
      },
    }
    const result = resolveProfile('rt', mockLoader(profiles))
    expect(result.model_file).toBe('Qwen3.6-27B-Q6_K.gguf')
    expect(result.runtime).toEqual({ spec_type: 'mtp', spec_draft_n: 3, gpu_layers: 999 })
  })

  it('child runtime block replaces parent runtime block entirely', () => {
    const profiles: Record<string, Profile> = {
      'parent': { name: 'parent', runtime: { spec_type: 'mtp', spec_draft_n: 2 } },
      'child': { name: 'child', extends: 'parent', runtime: { spec_draft_n: 5 } },
    }
    const result = resolveProfile('child', mockLoader(profiles))
    // Object fields in child replace parent's entirely (existing merge rule)
    expect(result.runtime).toEqual({ spec_draft_n: 5 })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/profiles/resolver.test.ts`
Expected: FAIL — `model_file`/`runtime` are not valid `Profile` keys (TS type error) and the assertions fail.

- [ ] **Step 3: Implement the type changes**

In `engine/profiles/types.ts`, add the runtime type before `Profile` and extend `Profile`:

```typescript
/**
 * llama-cpp launch parameters. Snake_case keys mirror the YAML profile.
 * Every key maps 1:1 onto ServerConfig in engine/llama/processManager.ts.
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
```

Then add these two fields to the `Profile` type (e.g. after `context_length?: number`):

```typescript
  model_file?: string
  runtime?: ProfileRuntime
```

`ResolvedProfile` needs no change — it is `Omit<Profile, 'extends'>`, so the new fields flow through automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/profiles/resolver.test.ts`
Expected: PASS (all existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add engine/profiles/types.ts engine/__tests__/profiles/resolver.test.ts
git commit -m "feat: add model_file + runtime block to profile schema"
```

---

### Task 2: Harden `modelResolver` — use `model_file`, error on multiple ggufs

**Files:**
- Modify: `engine/llama/modelResolver.ts`
- Test: `engine/__tests__/llama/modelResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

In `engine/__tests__/llama/modelResolver.test.ts`, **replace** the existing `it('picks largest GGUF when multiple exist', ...)` test (lines 49-58) with the new strict behavior, and add the `model_file` tests. The replacement and additions:

```typescript
  it('uses model_file exactly when provided', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6-27b-q6k')
    fs.mkdirSync(modelDir, { recursive: true })
    const wanted = path.join(modelDir, 'Qwen3.6-27B-Q6_K.gguf')
    const other = path.join(modelDir, 'Qwen3.6-35B-Q4_K_M.gguf')
    fs.writeFileSync(wanted, 'x'.repeat(50))
    fs.writeFileSync(other, 'x'.repeat(200)) // larger — must NOT be chosen
    const result = resolveModel('qwen3.6-27b-q6k', tmpDir, undefined, 'Qwen3.6-27B-Q6_K.gguf')
    expect(result).toBe(wanted)
  })

  it('throws when model_file is given but missing', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6-27b-q6k')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'something-else.gguf'), 'x')
    expect(() => resolveModel('qwen3.6-27b-q6k', tmpDir, undefined, 'Qwen3.6-27B-Q6_K.gguf'))
      .toThrow('Qwen3.6-27B-Q6_K.gguf')
  })

  it('throws and lists candidates when multiple ggufs and no model_file', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'a-Q2_K.gguf'), 'x'.repeat(50))
    fs.writeFileSync(path.join(modelDir, 'b-Q4_K_M.gguf'), 'x'.repeat(200))
    expect(() => resolveModel('qwen3.6', tmpDir))
      .toThrow(/multiple .gguf|set model_file/i)
  })
```

Keep the existing single-gguf test (`finds GGUF in model subdirectory`) — that path still works.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test engine/__tests__/llama/modelResolver.test.ts`
Expected: FAIL — `resolveModel` has no 4th arg; multi-gguf currently returns largest instead of throwing.

- [ ] **Step 3: Implement the resolver hardening**

Replace the body of `resolveModel` in `engine/llama/modelResolver.ts` (keep the existing imports and `ModelNotFoundError` usage):

```typescript
/**
 * Resolve a model name to a GGUF file path.
 *
 * Resolution order:
 * 1. Explicit modelPath (LOCALCODE_MODEL_PATH) — wins outright
 * 2. modelFile provided → use modelsDir/<modelName>/<modelFile> exactly; throw if absent
 * 3. No modelFile, folder has exactly one .gguf → use it
 * 4. No modelFile, folder has multiple .gguf → throw, listing candidates
 */
export function resolveModel(
  modelName: string,
  modelsDir: string,
  modelPath?: string,
  modelFile?: string,
): string {
  // 1. Explicit path override
  if (modelPath) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`LOCALCODE_MODEL_PATH does not exist: ${modelPath}`)
    }
    return modelPath
  }

  // Strip Ollama-style tags (e.g., "qwen3.6:latest" → "qwen3.6")
  const baseName = modelName.split(':')[0]
  const modelDir = path.join(modelsDir, baseName)
  if (!fs.existsSync(modelDir)) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  // 2. Explicit model_file → use it exactly
  if (modelFile) {
    const exact = path.join(modelDir, modelFile)
    if (!fs.existsSync(exact)) {
      throw new Error(
        `model_file '${modelFile}' not found in ${modelDir}. ` +
        `Check the profile's model_file matches the gguf on disk.`,
      )
    }
    return exact
  }

  const entries = fs.readdirSync(modelDir)
  const ggufs = entries.filter(f => f.endsWith('.gguf'))

  if (ggufs.length === 0) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  // 3. Exactly one → unambiguous
  if (ggufs.length === 1) {
    return path.join(modelDir, ggufs[0])
  }

  // 4. Multiple → never silently pick. Force the user to disambiguate.
  throw new Error(
    `Multiple .gguf files in ${modelDir}: ${ggufs.join(', ')}. ` +
    `Set model_file in your profile to choose one.`,
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test engine/__tests__/llama/modelResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/llama/modelResolver.ts engine/__tests__/llama/modelResolver.test.ts
git commit -m "harden: modelResolver uses model_file; errors on ambiguous multi-gguf dir"
```

---

### Task 3: Make `cache_ram` + `reasoning_budget` config-driven in `ServerConfig`

**Files:**
- Modify: `engine/llama/processManager.ts`
- Test: `engine/__tests__/llama/processManager.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/llama/processManager.test.ts` (or add to it if it exists):

```typescript
import { describe, expect, it, afterEach } from 'bun:test'
import { buildServerArgs } from '../../llama/processManager.js'

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('buildServerArgs', () => {
  afterEach(() => {
    delete process.env.LOCALCODE_CACHE_RAM
    delete process.env.LOCALCODE_REASONING_BUDGET
  })

  it('emits the canonical MTP profile args', () => {
    const args = buildServerArgs({
      modelPath: '/m/Qwen3.6-27B-Q6_K.gguf',
      port: 8081,
      ctxSize: 65536,
      specType: 'mtp',
      specDraftN: 3,
    })
    expect(argValue(args, '--ctx-size')).toBe('65536')
    expect(argValue(args, '--spec-type')).toBe('mtp')
    expect(argValue(args, '--spec-draft-n-max')).toBe('3')
  })

  it('uses config cacheRam/reasoningBudget over env and default', () => {
    process.env.LOCALCODE_CACHE_RAM = '9999'
    process.env.LOCALCODE_REASONING_BUDGET = '9999'
    const args = buildServerArgs({
      modelPath: '/m/x.gguf', port: 8081,
      cacheRam: 0, reasoningBudget: 256,
    })
    expect(argValue(args, '--cache-ram')).toBe('0')
    expect(argValue(args, '--reasoning-budget')).toBe('256')
  })

  it('falls back to env then default when config omits them', () => {
    const a1 = buildServerArgs({ modelPath: '/m/x.gguf', port: 8081 })
    expect(argValue(a1, '--cache-ram')).toBe('0')
    expect(argValue(a1, '--reasoning-budget')).toBe('256')
    process.env.LOCALCODE_CACHE_RAM = '2048'
    const a2 = buildServerArgs({ modelPath: '/m/x.gguf', port: 8081 })
    expect(argValue(a2, '--cache-ram')).toBe('2048')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/processManager.test.ts`
Expected: FAIL — `cacheRam`/`reasoningBudget` are not `ServerConfig` fields; config values are ignored.

- [ ] **Step 3: Implement the config fields**

In `engine/llama/processManager.ts`, add the two fields to `ServerConfig`:

```typescript
export type ServerConfig = {
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  loraPath?: string
  specType?: string
  specDraftN?: number
  cacheRam?: number
  reasoningBudget?: number
}
```

Add the same two fields to `ProcessManagerConfig` (so they flow through the manager):

```typescript
export type ProcessManagerConfig = {
  binaryPath: string
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  specType?: string
  specDraftN?: number
  cacheRam?: number
  reasoningBudget?: number
}
```

Then in `buildServerArgs`, change the cache/reasoning lines (currently lines ~52-58) to read config first, env second, default third:

```typescript
  const cacheRam = config.cacheRam != null
    ? String(config.cacheRam)
    : process.env.LOCALCODE_CACHE_RAM ?? '0'
  args.push('--cache-ram', cacheRam)

  const reasoningBudget = config.reasoningBudget != null
    ? String(config.reasoningBudget)
    : process.env.LOCALCODE_REASONING_BUDGET ?? '256'
  args.push('--reasoning-budget', reasoningBudget)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/processManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/llama/processManager.ts engine/__tests__/llama/processManager.test.ts
git commit -m "feat: make cache_ram and reasoning_budget profile-driven in ServerConfig"
```

---

### Task 4: Wire `model_file` + `runtime` into config, add `default.yaml` auto-load

**Files:**
- Modify: `engine/config.ts`
- Test: `engine/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `engine/__tests__/config.test.ts` (reuse the same temp-HOME pattern as the existing `describe('config with LOCALCODE_PROFILE', ...)` — copy its `beforeEach`/`afterEach`/`writeProfile` setup into the new block, or place these tests inside that existing block):

```typescript
describe('config runtime + auto-default', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  let tmpDir: string
  let origHome: string | undefined
  let origCwd: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-config-rt-'))
    fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true })
    origHome = process.env.HOME
    origCwd = process.cwd()
    process.env.HOME = path.join(tmpDir, 'home')
    process.chdir(path.join(tmpDir, 'project'))
  })

  afterEach(() => {
    process.env.HOME = origHome
    process.chdir(origCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LOCALCODE_')) delete process.env[key]
    }
  })

  function writeGlobalProfile(name: string, content: string) {
    const dir = path.join(tmpDir, 'home', '.cynco', 'profiles')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.yml`), content)
  }

  it('maps model_file and runtime block into config (camelCase)', () => {
    writeGlobalProfile('rt', `
name: rt
model: qwen3.6-27b-q6k
model_file: Qwen3.6-27B-Q6_K.gguf
context_length: 65536
runtime:
  spec_type: mtp
  spec_draft_n: 3
  cache_ram: 0
  reasoning_budget: 256
`)
    process.env.LOCALCODE_PROFILE = 'rt'
    const c = loadConfig()
    expect(c.modelFile).toBe('Qwen3.6-27B-Q6_K.gguf')
    expect(c.contextLength).toBe(65536)
    expect(c.runtime).toEqual({
      specType: 'mtp', specDraftN: 3, cacheRam: 0, reasoningBudget: 256,
    })
  })

  it('auto-loads the default profile when LOCALCODE_PROFILE is unset', () => {
    writeGlobalProfile('default', `
name: default
model: qwen3.6-27b-q6k
model_file: Qwen3.6-27B-Q6_K.gguf
context_length: 65536
runtime:
  spec_type: mtp
  spec_draft_n: 3
`)
    // no LOCALCODE_PROFILE, no LOCALCODE_MODEL
    const c = loadConfig()
    expect(c.model).toBe('qwen3.6-27b-q6k')
    expect(c.modelFile).toBe('Qwen3.6-27B-Q6_K.gguf')
    expect(c.contextLength).toBe(65536)
    expect(c.runtime?.specType).toBe('mtp')
  })

  it('returns built-in defaults when no profile and no default.yaml', () => {
    const c = loadConfig()
    expect(c.model).toBeUndefined()
    expect(c.modelFile).toBeUndefined()
    expect(c.runtime).toBeUndefined()
  })

  it('env LOCALCODE_MODEL overrides the auto-default profile model', () => {
    writeGlobalProfile('default', `
name: default
model: qwen3.6-27b-q6k
model_file: Qwen3.6-27B-Q6_K.gguf
`)
    process.env.LOCALCODE_MODEL = 'env-model:13b'
    const c = loadConfig()
    expect(c.model).toBe('env-model:13b')
    // model_file still comes from the auto-default profile
    expect(c.modelFile).toBe('Qwen3.6-27B-Q6_K.gguf')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test engine/__tests__/config.test.ts`
Expected: FAIL — `config.modelFile`/`config.runtime` do not exist; no auto-default loading.

- [ ] **Step 3: Implement the config changes**

In `engine/config.ts`:

(a) Add the camelCase runtime type after the `TierSetting` type:

```typescript
export type RuntimeConfig = {
  specType?: string
  specDraftN?: number
  gpuLayers?: number
  batchSize?: number
  flashAttn?: boolean
  cacheRam?: number
  reasoningBudget?: number
}
```

(b) Add two fields to `LocalCodeConfig` (after `modelPath`):

```typescript
  modelFile: string | undefined
  runtime: RuntimeConfig | undefined
```

(c) Change `loadProfileConfig` to add the auto-default tier:

```typescript
function loadProfileConfig(): ResolvedProfile | null {
  const profileName = process.env.LOCALCODE_PROFILE
  try {
    if (profileName) return resolveProfile(profileName)
    // Auto-default tier: when no profile is named, load 'default' if it exists.
    const def = resolveProfile('default')
    console.log("[config] loaded profile 'default'")
    return def
  } catch {
    // Named profile not found, or no default.yaml present — continue with defaults.
    return null
  }
}
```

(d) In `loadConfig`, after the existing `model` block, derive `modelFile` and `runtime` (snake→camel map, runtime omitted entirely if the profile has none):

```typescript
  // --- modelFile ---
  const modelFile = profile?.model_file ?? undefined

  // --- runtime (snake_case profile → camelCase RuntimeConfig) ---
  const pr = profile?.runtime
  const runtime: RuntimeConfig | undefined = pr
    ? {
        specType: pr.spec_type,
        specDraftN: pr.spec_draft_n,
        gpuLayers: pr.gpu_layers,
        batchSize: pr.batch_size,
        flashAttn: pr.flash_attn,
        cacheRam: pr.cache_ram,
        reasoningBudget: pr.reasoning_budget,
      }
    : undefined
```

(e) Add `modelFile` and `runtime` to the returned object (after `modelPath`):

```typescript
    modelPath,
    modelFile,
    runtime,
```

Note: the snake→camel map intentionally keeps `undefined` values so `toEqual` in the test passes only for keys present in YAML. If the test's `toEqual` is strict about absent keys, the YAML in the test sets exactly `spec_type`, `spec_draft_n`, `cache_ram`, `reasoning_budget`; the other four map to `undefined`. Bun's `toEqual` treats `{a:1, b:undefined}` as equal to `{a:1}`, so the assertion holds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test engine/__tests__/config.test.ts`
Expected: PASS (existing config tests still green — they set `LOCALCODE_PROFILE` or have no `default.yaml` under the temp HOME, so auto-default is a no-op for them).

- [ ] **Step 5: Commit**

```bash
git add engine/config.ts engine/__tests__/config.test.ts
git commit -m "feat: config maps model_file/runtime and auto-loads default profile"
```

---

### Task 5: Wire config → `resolveModel` + `ProcessManager` in `main.ts`

**Files:**
- Modify: `engine/main.ts:159-177`

No new unit test — this is integration glue verified by the live verification (Task 10) and the full suite. The change is mechanical: pass the new config fields through.

- [ ] **Step 1: Pass `model_file` into `resolveModel`**

In `engine/main.ts`, change line 161 from:

```typescript
    const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath)
```

to:

```typescript
    const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath, config.modelFile)
```

- [ ] **Step 2: Build `ProcessManager` from `config.runtime`**

Replace the `ProcessManager` construction (lines 166-177) with runtime-sourced values, env still overriding via config merge upstream. Use `??` so a profile-less run keeps today's behavior:

```typescript
    const { ProcessManager } = await import('./llama/processManager.js')
    const rt = config.runtime
    const processManager = new ProcessManager({
      binaryPath,
      modelPath,
      port: config.port,
      ctxSize: config.contextLength ?? 32768,
      batchSize: rt?.batchSize ?? config.batchSize,
      gpuLayers: rt?.gpuLayers ?? config.gpuLayers,
      flashAttn: rt?.flashAttn ?? config.flashAttn,
      threads: config.threads,
      specType: process.env.LOCALCODE_SPEC_TYPE || rt?.specType || undefined,
      specDraftN: process.env.LOCALCODE_SPEC_DRAFT_N
        ? parseInt(process.env.LOCALCODE_SPEC_DRAFT_N, 10)
        : rt?.specDraftN,
      cacheRam: rt?.cacheRam,
      reasoningBudget: rt?.reasoningBudget,
    })
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx vitest run`
Expected: 0 failures (matches the `cf75f8e` baseline). If TypeScript reports an error on the new fields, fix the field name to match Tasks 1/3/4 exactly.

- [ ] **Step 4: Commit**

```bash
git add engine/main.ts
git commit -m "feat: wire profile model_file + runtime into resolveModel and ProcessManager"
```

---

### Task 6: Canonical default profile — repo template + live file

**Files:**
- Create: `engine/profiles/templates/default.yaml`
- Create: `~/.cynco/profiles/default.yaml` (live, from template)

- [ ] **Step 1: Create the repo template**

Write `engine/profiles/templates/default.yaml`:

```yaml
name: default
model: qwen3.6-27b-q6k
model_file: Qwen3.6-27B-Q6_K.gguf
context_length: 65536
temperature: 0.7
runtime:
  spec_type: mtp
  spec_draft_n: 3
```

- [ ] **Step 2: Create the live profile (only if absent — never clobber)**

Run (bash):

```bash
mkdir -p ~/.cynco/profiles
if [ ! -f ~/.cynco/profiles/default.yaml ]; then
  cp engine/profiles/templates/default.yaml ~/.cynco/profiles/default.yaml
  echo "created ~/.cynco/profiles/default.yaml"
else
  echo "live default.yaml already exists — left untouched"
fi
```

- [ ] **Step 3: Verify the live profile resolves**

Run (bash):

```bash
bun -e "import('./engine/profiles/resolver.js').then(m => console.log(JSON.stringify(m.resolveProfile('default'), null, 2)))"
```

Expected: prints the resolved profile with `model_file: Qwen3.6-27B-Q6_K.gguf` and the `runtime` block.

- [ ] **Step 4: Commit (template only — live file lives outside the repo)**

```bash
git add engine/profiles/templates/default.yaml
git commit -m "feat: ship canonical default.yaml profile template"
```

---

### Task 7: Rename model folders to `<family>-<params>-<quant>`

**Files:**
- `~/.cynco/models/qwen3.6-mtp/` → `~/.cynco/models/qwen3.6-27b-q6k/`
- `~/.cynco/models/qwen3.6/` → `~/.cynco/models/qwen3.6-35b-a3b-q4km/`

This touches on-disk state, not the repo. Do it carefully — confirm the daemon is not mid-run (no llama-server on 8081) before renaming.

- [ ] **Step 1: Confirm current layout and that no server is running**

Run (bash):

```bash
ls -la ~/.cynco/models/
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/health || echo " (no server — safe to rename)"
```

Expected: see `qwen3.6/` and `qwen3.6-mtp/`; health check fails (no running server).

- [ ] **Step 2: Rename both folders**

Run (bash):

```bash
mv ~/.cynco/models/qwen3.6-mtp ~/.cynco/models/qwen3.6-27b-q6k
mv ~/.cynco/models/qwen3.6 ~/.cynco/models/qwen3.6-35b-a3b-q4km
ls -la ~/.cynco/models/
ls ~/.cynco/models/qwen3.6-27b-q6k/
```

Expected: the two new folder names exist; `qwen3.6-27b-q6k/` contains `Qwen3.6-27B-Q6_K.gguf`.

- [ ] **Step 3: Verify resolution end-to-end against the new layout**

Run (bash):

```bash
bun -e "import('./engine/llama/modelResolver.js').then(m => { const os=require('os'),p=require('path'); console.log(m.resolveModel('qwen3.6-27b-q6k', p.join(os.homedir(),'.cynco','models'), undefined, 'Qwen3.6-27B-Q6_K.gguf')) })"
```

Expected: prints the full path ending in `qwen3.6-27b-q6k/Qwen3.6-27B-Q6_K.gguf`.

No commit — this step changes only local disk state.

---

### Task 8: Drop hardcoded launch fallbacks from the TUI launcher

**Files:**
- Modify: `tui/localcode_tui/screens/project_picker.py:190-193`

- [ ] **Step 1: Replace the hardcoded model/ctx injection**

In `tui/localcode_tui/screens/project_picker.py`, replace lines 190-193:

```python
        # Get model from config or env
        model = os.environ.get("LOCALCODE_MODEL") or getattr(self.app.config, "model", None) or "gemma4:31b"
        context_length = os.environ.get("LOCALCODE_CONTEXT_LENGTH") or str(getattr(self.app.config, "context_length", 65536))

        env = {**os.environ, "LOCALCODE_MODEL": model, "LOCALCODE_CONTEXT_LENGTH": context_length}
```

with — only forward an override the user actually set; otherwise let the engine's `default.yaml` auto-load decide:

```python
        # Source of truth is the engine's profile (default.yaml auto-loads when
        # LOCALCODE_PROFILE is unset). Only forward explicit user overrides so
        # the launcher can never silently diverge from the daemon's config.
        env = {**os.environ}
        explicit_model = os.environ.get("LOCALCODE_MODEL") or getattr(self.app.config, "model", None)
        if explicit_model:
            env["LOCALCODE_MODEL"] = explicit_model
        explicit_ctx = os.environ.get("LOCALCODE_CONTEXT_LENGTH")
        if explicit_ctx:
            env["LOCALCODE_CONTEXT_LENGTH"] = explicit_ctx
```

- [ ] **Step 2: Verify the TUI test suite still passes**

Run (bash): `cd tui && python -m pytest tests/ -q`
Expected: no new failures versus baseline. If a project_picker test asserted the old `gemma4:31b`/`65536` injection, update it to assert the new conditional behavior (only sets the env keys when an explicit override exists).

- [ ] **Step 3: Commit**

```bash
git add tui/localcode_tui/screens/project_picker.py
git commit -m "fix: TUI launcher defers to engine profile, drops gemma4/65536 fallbacks"
```

---

### Task 9: Drop `LOCALCODE_MODEL=qwen3.6` from the daemon launch docs

**Files:**
- Modify: `docs/liveness-setup.md:94-95, 108-110`

- [ ] **Step 1: Remove the stale model env from both launch snippets**

In `docs/liveness-setup.md`, edit the Task Scheduler command (line 95) to drop `set LOCALCODE_MODEL=qwen3.6&& ` so it reads:

```
  /TR "cmd /c set CYNCO_NTFY_URL=http://100.101.102.103:8090&& set CYNCO_NTFY_TOKEN=tk_yourtoken&& set LOCALCODE_PROVIDER=llama-cpp&& cd /d C:\Users\civer\localcode&& bun engine\daemon\main.ts >> %USERPROFILE%\.cynco\daemon.log 2>&1"
```

And the smoke-test snippet (lines 108-109) to drop `LOCALCODE_MODEL=qwen3.6 `:

```bash
CYNCO_NTFY_URL=http://100.101.102.103:8090 CYNCO_NTFY_TOKEN=tk_... \
LOCALCODE_PROVIDER=llama-cpp \
bun engine/daemon/main.ts
```

- [ ] **Step 2: Add a one-line note explaining why**

Directly under the Task Scheduler code block (after line 96), add:

```markdown
> The daemon no longer sets `LOCALCODE_MODEL`. With it unset, the engine auto-loads
> `~/.cynco/profiles/default.yaml` (the canonical 27B-Q6_K / 64k / MTP config), so
> the daemon and the interactive TUI provably run the same model.
```

- [ ] **Step 3: Commit**

```bash
git add docs/liveness-setup.md
git commit -m "docs: daemon launch drops LOCALCODE_MODEL, relies on default.yaml auto-load"
```

---

### Task 10: Blocking wire-check + full suite + live verification

This is the standing user rule: every new symbol must be read on the live path, not only in tests; and no divergent literals may remain. **This task gates completion.**

- [ ] **Step 1: Grep every new symbol is defined AND consumed on the live path**

Run (bash) — each must appear in BOTH a definition site and a non-test consumer:

```bash
echo "== model_file / modelFile ==";   grep -rn "model_file\|modelFile" engine --include=*.ts | grep -v __tests__
echo "== runtime block (config) ==";   grep -rn "runtime" engine/config.ts engine/main.ts
echo "== ProfileRuntime ==";           grep -rn "ProfileRuntime" engine --include=*.ts | grep -v __tests__
echo "== RuntimeConfig ==";            grep -rn "RuntimeConfig" engine --include=*.ts | grep -v __tests__
echo "== cacheRam / reasoningBudget =="; grep -rn "cacheRam\|reasoningBudget" engine --include=*.ts | grep -v __tests__
echo "== auto-default loader ==";      grep -rn "loaded profile 'default'\|resolveProfile('default')" engine/config.ts
```

Expected, on the live path (not tests):
- `modelFile` defined in `config.ts` + `types.ts`, passed in `main.ts` to `resolveModel`, consumed in `modelResolver.ts`.
- `runtime` mapped in `config.ts`, consumed in `main.ts` (`rt?.…`).
- `cacheRam`/`reasoningBudget` in `processManager.ts` `ServerConfig`+`buildServerArgs`+`ProcessManagerConfig`, and set in `main.ts`.
- auto-default loader present in `config.ts`.

If any new symbol appears ONLY in `__tests__`, it is dead on the live path — fix the wiring before proceeding.

- [ ] **Step 2: Grep that NO divergent literals remain**

Run (bash):

```bash
echo "== bare qwen3.6 / qwen3.6-mtp in launch/config paths ==";
grep -rn "qwen3.6-mtp\|LOCALCODE_MODEL=qwen3.6\|'qwen3.6'\|\"qwen3.6\"" \
  engine/main.ts engine/config.ts docs/liveness-setup.md \
  tui/localcode_tui/screens/project_picker.py 2>/dev/null
echo "== gemma4:31b / 65536 fallback in TUI launcher ==";
grep -n "gemma4:31b\|65536" tui/localcode_tui/screens/project_picker.py
```

Expected: NO matches in any of these files. (The retired model is now referenced only as the renamed folder `qwen3.6-35b-a3b-q4km` and never named in code; the canonical name `qwen3.6-27b-q6k` lives only in the profile YAML, not in these launch/config files.)

- [ ] **Step 3: Full suite vs. baseline**

Run: `npx vitest run`
Expected: 0 failures (the `cf75f8e` green baseline).

- [ ] **Step 4: Live verification — daemon runs the right config**

Restart the daemon with **no** `LOCALCODE_MODEL` / `LOCALCODE_CONTEXT_LENGTH` / `LOCALCODE_SPEC_*` in env (only `LOCALCODE_PROVIDER=llama-cpp` + the ntfy vars). Then trigger one task and inspect the spawned command in `~/.cynco/daemon.log`:

```bash
grep -n "Starting:.*llama-server" ~/.cynco/daemon.log | tail -1
```

Expected: the most recent llama-server launch line contains all of:
`Qwen3.6-27B-Q6_K.gguf`, `--ctx-size 65536`, `--spec-type mtp`, `--spec-draft-n-max 3`, `--cache-ram 0`, `--reasoning-budget 256`.

- [ ] **Step 5: Live verification — a real task completes**

Confirm the triggered task produced a successful outcome:

```bash
ls -t ~/.cynco/missions/mfl-dynasty/tasks/outcome-*.json 2>/dev/null | head -1 | xargs grep -l '"ok": *true' 2>/dev/null && echo "OK: task completed with ok:true"
```

Expected: prints the outcome path + `OK: task completed with ok:true`.

- [ ] **Step 6: Final commit (if any wire-check fixes were made)**

```bash
git add -A
git commit -m "chore: wire-check fixes for unified runtime config"
```

---

## Self-Review

- **Spec coverage:** §1 schema → Task 1; §2 default.yaml + auto-load → Tasks 4, 6 (+ TUI Task 8, daemon Task 9); §3 resolver hardening → Task 2, dir cleanup → Task 7; §4 wiring → Tasks 3, 4, 5; Verification → Task 10. All sections covered.
- **Type consistency:** `model_file` (YAML/`Profile`) ↔ `modelFile` (`LocalCodeConfig`, `resolveModel` arg); `ProfileRuntime` (snake, profile) ↔ `RuntimeConfig` (camel, config) ↔ `ServerConfig.cacheRam/reasoningBudget`. `resolveModel(modelName, modelsDir, modelPath?, modelFile?)` signature is used identically in Task 2 (def), Task 5 (call), Task 7 (verify).
- **No placeholders:** every code step shows complete code; every run step shows the exact command + expected output.
- **Env precedence preserved:** env still wins (config merge unchanged for model/ctx/spec; `cache_ram`/`reasoning_budget` read config→env→default in `buildServerArgs`).
