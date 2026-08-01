/**
 * The promotion stage produced an adapter the engine could never load, and
 * reported success both times it could have said so.
 *
 * Measured 2026-07-31. `convert_and_promote.sh` used ONE string for two jobs:
 *
 *     TAG="cynco-personalized:v1"
 *     cp "$GGUF_OUT" "${ADAPTERS_DIR}/${TAG}.gguf"   # a filename
 *     ollama create "$TAG" -f "$MODELFILE"           # a model tag
 *
 * A colon is the conventional separator in an Ollama tag and is illegal in an
 * NTFS filename — Windows reads `name:stream` as an alternate data stream. The
 * `cp` does not fail, because MSYS silently maps the colon to U+F03A, so bash
 * writes a file that node lists as `cynco-personalizedv1.gguf`. Meanwhile
 * `resolveAdapter` builds `path.join(dir, 'cynco-personalized:v1.gguf')` with a
 * real colon. The name written and the name looked up are different strings and
 * always will be:
 *
 *     resolveAdapter('cynco-personalized:v1', dir)
 *       => AdapterNotFoundError, on a directory that contains the adapter
 *
 * That is the whole promotion path: it exits 0, prints "Adapter promoted as",
 * tells you to `set LOCALCODE_ADAPTER=cynco-personalized:v1`, and the engine
 * then refuses to start with that adapter forever.
 *
 * The fix is not to escape the colon. It is that a filename and a model tag are
 * two values, so they get two fields — the same repair as finding (ah), where
 * one sentence was serving as both prose and data.
 *
 * `version` reaches all three names straight from argv, so it is validated
 * here. `--version ../../../evil` otherwise writes outside the adapters
 * directory, and `--version .` resolves the adapter directory to its parent.
 */
import { describe, expect, it } from 'vitest'
import { adapterNames } from '../../training/adapterNames.js'

describe('the three names a version produces', () => {
  it('gives the file a name a filesystem accepts', () => {
    // The regression. No colon, no path separator, nothing NTFS reinterprets.
    const n = adapterNames('v1')
    expect(n.file).toBe('cynco-personalized-v1')
    expect(n.file).not.toContain(':')
  })

  it('keeps the colon in the Ollama tag, where it is the correct separator', () => {
    expect(adapterNames('v1').ollamaTag).toBe('cynco-personalized:v1')
  })

  it('names the adapter directory, so train and promote cannot disagree', () => {
    // These were two separate `sft-${version}` literals in runTraining.ts.
    // Promote reads what train wrote; a divergence is silent and total.
    expect(adapterNames('v1').dir).toBe('sft-v1')
  })

  it('round-trips through the engine resolver', () => {
    // The claim that actually failed: what the script writes must be what
    // `resolveAdapter(name, dir)` looks for, which is `<name>.gguf`.
    const n = adapterNames('v2')
    expect(`${n.file}.gguf`).toBe('cynco-personalized-v2.gguf')
  })
})

describe('a version that reaches the filesystem is validated first', () => {
  it('accepts ordinary versions', () => {
    for (const v of ['v1', 'v10', '2026-07-31', 'exp.3', 'a_b']) {
      expect(() => adapterNames(v)).not.toThrow()
    }
  })

  it('refuses path separators', () => {
    expect(() => adapterNames('../../evil')).toThrow(/version/i)
    expect(() => adapterNames('a/b')).toThrow(/version/i)
    expect(() => adapterNames('a\\b')).toThrow(/version/i)
  })

  it('refuses the two names that traverse without a separator', () => {
    // Both match [A-Za-z0-9._-]+ and both are directories, not versions.
    expect(() => adapterNames('.')).toThrow(/version/i)
    expect(() => adapterNames('..')).toThrow(/version/i)
  })

  it('refuses a colon, which is what started this', () => {
    expect(() => adapterNames('v1:2')).toThrow(/version/i)
  })

  it('refuses empty', () => {
    expect(() => adapterNames('')).toThrow(/version/i)
  })

  it('names the offending value, so the message is actionable', () => {
    expect(() => adapterNames('a/b')).toThrow(/a\/b/)
  })
})
