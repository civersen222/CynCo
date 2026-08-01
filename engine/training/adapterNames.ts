/**
 * The three names a training version produces, derived once.
 *
 * They were previously three string literals in two files: `sft-${version}` in
 * `stageTrain` and again in `stagePromote`, and `cynco-personalized:${version}`
 * used as BOTH an Ollama model tag and a filename. The second of those is the
 * defect this module exists for — a colon separates a tag and is illegal in an
 * NTFS filename, so the promotion wrote a file the engine could never resolve
 * and exited 0. See engine/__tests__/training/adapterNames.test.ts.
 */

/** Conservative: what is safe in a filename on every platform we run on. */
const VERSION_OK = /^[A-Za-z0-9._-]+$/

export type AdapterNames = {
  /** Directory under ~/.cynco/adapters that the trainer writes into. */
  dir: string
  /** File stem under ~/.cynco/adapters — `resolveAdapter` appends `.gguf`. */
  file: string
  /** Ollama model tag, where a colon is the correct separator. */
  ollamaTag: string
}

export function adapterNames(version: string): AdapterNames {
  // `.` and `..` both match VERSION_OK and are both directories, so the
  // character class alone is not enough.
  if (!VERSION_OK.test(version) || version === '.' || version === '..') {
    throw new Error(
      `Invalid version ${JSON.stringify(version)}: a version reaches the filesystem, ` +
      `so it must match ${VERSION_OK} and must not be "." or "..".`,
    )
  }
  return {
    dir: `sft-${version}`,
    file: `cynco-personalized-${version}`,
    ollamaTag: `cynco-personalized:${version}`,
  }
}
