/**
 * Per-session, append-only set of loaded tool names.
 *
 * Seeded once with the core tools at session start. `load_tools`, `run_skill`,
 * and S5 proactive surfacing all grow it via `surface()` — it never shrinks.
 * The conversation loop reads it each turn to decide which registry tools to
 * offer the model. Because it only ever grows (append-only), surfacing a tool
 * on turn N keeps it available on every subsequent turn without re-asking.
 *
 * S5's reactive *restrictions* (doom-loop exclusion, stuck escape, variety)
 * are applied downstream as an intersection over whatever is loaded — they do
 * not mutate this set.
 */
export class LoadedToolSet {
  private readonly loaded: Set<string>

  constructor(seed: string[]) {
    this.loaded = new Set(seed)
  }

  /** True if the named tool is currently loaded. */
  has(name: string): boolean {
    return this.loaded.has(name)
  }

  /**
   * Add tool names to the loaded set. Idempotent — re-surfacing a loaded tool
   * is a no-op. Returns the names that were NOT already loaded, so the caller
   * can build a tool-availability block containing only the newly-added tools.
   */
  surface(names: string[]): string[] {
    const added: string[] = []
    for (const name of names) {
      if (!this.loaded.has(name)) {
        this.loaded.add(name)
        added.push(name)
      }
    }
    return added
  }

  /** All currently-loaded names (insertion order). */
  names(): string[] {
    return [...this.loaded]
  }

  /** A stable-sorted defensive copy — mutating it does not affect this set. */
  snapshot(): string[] {
    return [...this.loaded].sort()
  }
}
