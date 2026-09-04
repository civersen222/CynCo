# engine/profiles

## Purpose
Defines and resolves the YAML profile schema LocalCode reads from `.cynco/profiles/`, `~/.cynco/profiles/`, and the bundled `engine/profiles/templates/default.yaml`, including the `runtime` block of llama-server launch knobs (`context_length` lives on the profile root; `cache_ram`, `ctx_checkpoints`, `checkpoint_min_step`, `chat_template_file`, `cache_type_k/v`, `gpu_layers`, `batch_size`, `flash_attn`, `spec_type`/`spec_draft_n`, `reasoning_budget`, `ubatch_size`, `chat_template_kwargs`). `engine/config.ts` is the sole caller — it loads the named or auto-default profile, layers `LOCALCODE_*` env vars on top (env always wins), and hands the merged `RuntimeConfig` to `bootstrapProvider.ts`, which forwards it to `ProcessManager` (`engine/llama/processManager.ts`). This package must never talk to llama-server, the filesystem outside the three profile directories, or apply env overrides itself — that layering belongs to `config.ts` alone. F91 (a `--ctx-size`/`--ctx-checkpoints`/`--cache-ram` misread that under-sized cache RAM) is why `cache_ram` and `ctx_checkpoints` exist as independent, explicit fields here rather than being derived implicitly; the actual derivation/validation lives in `engine/llama/processManager.ts`, not in this package.

## Key files
| File | Role |
|---|---|
| `types.ts` | `Profile`, `ResolvedProfile`, `ProfileRuntime`, `ToolScoping`, `CapabilityOverrides` type definitions — the YAML schema contract. |
| `loader.ts` | Reads and parses one profile YAML from disk, searching project-local → global → bundled directories; also lists all available profile names. |
| `resolver.ts` | Follows a profile's `extends:` chain and merges ancestor-to-child into a flat `ResolvedProfile`. |

## Important types & functions
- **`ProfileRuntime`** (`types.ts:32`) — snake_case launch-parameter block (`cache_ram`, `ctx_checkpoints`, `chat_template_file`, etc.); each key is "the design source for a ServerConfig field in engine/llama/processManager.ts" per its own doc comment. Read by `config.ts`'s `loadConfig()`.
- **`Profile`** (`types.ts:54`) — raw shape parsed straight from YAML, including `extends` and `provider`. `provider` follows env > profile > built-in (`llama-cpp`), same as every other field.
- **`ResolvedProfile`** (`types.ts:91`) — post-inheritance profile with `extends` stripped; this is what `resolveProfile()` returns and what `config.ts` consumes.
- **`loadProfile(name)`** (`loader.ts:114`) — returns one `Profile | null` by searching `.cynco/profiles/`, `~/.cynco/profiles/`, then `engine/profiles/templates/`, in that priority order. Called by `resolver.ts`'s default loader and by `configHandlers.ts` (via `listProfiles`).
- **`listProfiles()`** (`loader.ts:135`) — deduplicated, sorted profile names across all three directories, including bundled ones, so `/model` can name a profile the engine can actually run. Used by `engine/bridge/configHandlers.ts` for `profile.list`.
- **`resolveProfile(name, loader?)`** (`resolver.ts:81`) — walks the `extends:` chain (max depth 5, circular-safe) and merges child-over-parent; throws if the root profile itself is not found. Called by `engine/config.ts`'s `loadProfileConfig()`.

## Data flow
1. A YAML profile file sits in `.cynco/profiles/<name>.yml`, `~/.cynco/profiles/<name>.yml`, or `engine/profiles/templates/<name>.yaml`.
2. `engine/config.ts::loadConfig()` calls `loadProfileConfig()`, which calls `resolveProfile(LOCALCODE_PROFILE ?? 'default')`.
3. `resolveProfile()` (`resolver.ts`) calls `loadProfile()` (`loader.ts`) to walk the `extends:` chain, then `mergeChain()` flattens it into a `ResolvedProfile`.
4. `loadConfig()` maps the profile's snake_case `runtime` block onto the camelCase `RuntimeConfig` (`engine/config.ts:161`) and layers `LOCALCODE_*` env vars over every field, env winning.
5. `bootstrapProvider.ts` reads `config.runtime` (`rt`) and passes each field — `cacheRam`, `ctxCheckpoints`, `checkpointMinStep`, `chatTemplateFile`, `cacheTypeK/V`, `chatTemplateKwargs`, etc. — into `new ProcessManager({...})`, with `config.contextLength ?? DEFAULT_CTX_SIZE` for the context window.
6. `ProcessManager` (`engine/llama/processManager.ts`) turns those fields into `llama-server` CLI flags, including the F91-aware `--cache-ram` derivation from context size and checkpoint count.

## Gotchas
- The bundled `engine/profiles/templates/default.yaml` is the last-resort tier; a user profile of the same name in `.cynco/profiles/` or `~/.cynco/profiles/` always wins ("Bundled last, so a user profile of the same name always wins and the shipped one is a floor rather than a ceiling" — `loader.ts:21`). Pinned by `engine/__tests__/profiles/loader.test.ts` (`'yields to a project-local profile of the same name'`, `'yields to a global profile of the same name'`).
- Before the bundled directory was added, a fresh clone with no `~/.cynco` resolved `default` to `null`, `config.model` came out `undefined`, and `main.ts` exited 1 — "Every command in the README's Quick Start hit this" (`loader.ts:11-19`). Pinned by `engine/__tests__/profiles/loader.test.ts` (`'resolves without a user profile, an env var, or a home directory'`, `'names a model, which is the field main.ts exits on when it is missing'`) and `engine/__tests__/config.test.ts` (`'falls back to the profile that ships with the engine when the user has none'`).
- `bundledProfilesDir()` resolves relative to this module's own location (`import.meta.url`), not `process.cwd()`, because the engine normally runs from the user's project directory, which has no `engine/` in it (`loader.ts:70-77`). Pinned by `'is found relative to the engine, not to the working directory'`.
- `provider` on a `Profile` used to be ignored entirely, so a profile could name a model and still boot the wrong provider — the README's Ollama Quick Start (no env vars) booted `llama-cpp` looking for a GGUF while the docs said the default was `ollama` (`types.ts:64`, `engine/config.ts:205`). Pinned by `engine/__tests__/config.test.ts` (`'provider resolves env > profile > built-in'`).
- Object fields (`tools`, `capabilities`) and arrays replace, not merge, across `extends:` — a child's `tools.allowed` entirely replaces the parent's, it does not union (`resolver.ts:6-8`). Pinned by `engine/__tests__/profiles/resolver.test.ts` (`'tools.allowed in child replaces parent (not union)'`, `'tools.denied in child replaces parent denied'`, `'child runtime block replaces parent runtime block entirely'`).
- `extends:` chains cap at depth 5 with circular-reference protection — a self-referencing or overly deep chain silently truncates rather than looping or throwing (`resolver.ts:9,30-32`). Pinned by `'caps inheritance at depth 5 (circular reference protection)'`.
- `homeDir()` deliberately reads `process.env.HOME` on every call instead of caching `os.homedir()`, because Bun caches `os.homedir()` at startup and tests need to change `HOME` mid-run (`loader.ts:44-50`).
- `cache_ram` and `ctx_checkpoints` in `ProfileRuntime` are two halves of one F91-shaped decision with `--ctx-size` that must move together in `processManager.ts`, not be set independently without checking the derivation there (`types.ts:38,40`; see `engine/llama/processManager.ts:132,145` and `engine/__tests__/llama/processManager.test.ts` `'context size, checkpoints and cache-ram move together (F91)'`).
