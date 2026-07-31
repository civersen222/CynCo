import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'

/**
 * BLOCKING wire-check: the README's Quick Start must install the model the
 * engine will actually run on.
 *
 * The Quick Start had three independent blockers, each sufficient on its own:
 *
 *  1. No model resolved. `config.ts` falls back to the profile named `default`
 *     when `LOCALCODE_MODEL` is unset, and `main.ts` exits 1 with "No model
 *     specified" when the resolved model is undefined.
 *  2. The bundled default profile was unreachable. The loader searched
 *     `.cynco/profiles/` and `~/.cynco/profiles/` only, and the shipped file at
 *     `engine/profiles/templates/default.yaml` was a path no code read.
 *  3. The TUI passes no model, on purpose — `build_engine_env` documents that
 *     forwarding a stale TUI config would silently override the engine profile.
 *     Sound, but it assumes the engine has a profile, and per (2) it did not.
 *
 * (2) is fixed in `profiles/loader.ts` and specified in
 * `engine/__tests__/profiles/loader.test.ts`. What is left is the coupling this
 * file guards: resolving a model is not the same as resolving a model the user
 * has. The shipped default named `qwen3.6-27b-q6k` and the Quick Start said
 * `ollama pull qwen3.6`, so a clone that followed the instructions to the letter
 * would boot and then 404 on its first request — a failure one step later and
 * considerably harder to read than the exit-1 it replaced.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8')

/**
 * The profile as SHIPPED, read straight off disk.
 *
 * Deliberately not `loadProfile('default')`: that honours the search order, so
 * on any developer's machine it returns their own `~/.cynco/profiles/default`
 * and this file would grade their config instead of the repository's. The
 * artefact a fresh clone gets is the only thing under test here.
 */
function bundledDefault(): Record<string, unknown> {
  const path = join(repoRoot, 'engine', 'profiles', 'templates', 'default.yaml')
  return parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

/** Every model tag the README tells the reader to `ollama pull`. */
function pulledModels(): string[] {
  return [...readme.matchAll(/ollama pull\s+(\S+)/g)].map(m => m[1]!)
}

describe('the Quick Start installs the model the engine defaults to', () => {
  it('the README tells the reader to pull something', () => {
    // Guards the guard: a reworded README that no longer contains the command
    // would make the assertion below pass against an empty list.
    expect(
      pulledModels().length,
      'no `ollama pull` line in README.md — the Quick Start changed shape and this guard is stale',
    ).toBeGreaterThan(0)
  })

  it('the bundled default profile names one of them', () => {
    const model = bundledDefault().model
    expect(typeof model, 'the shipped default profile names no model at all').toBe('string')
    expect(
      pulledModels(),
      `The engine's fallback profile runs on ${JSON.stringify(model)}, which the Quick Start\n` +
        `never installs. It pulls: ${pulledModels().join(', ')}.\n` +
        'A user who follows the README gets an engine that starts and then asks the\n' +
        'provider for a tag it does not have. Change one to match the other.',
    ).toContain(model)
  })

  it('the fallback does not presume a GGUF the Quick Start never downloads', () => {
    // `model_file` and the draft-mtp runtime belong to the llama.cpp direct
    // provider, which the README documents as opt-in through LOCALCODE_PROVIDER
    // and its own env. Shipping them in the fallback makes the default path
    // depend on a file no Quick Start step creates.
    const bundled = bundledDefault()
    expect(bundled.model_file).toBeUndefined()
    expect(bundled.runtime).toBeUndefined()
  })
})
