/**
 * Run a body and guarantee a finalizer runs exactly once afterwards, whatever
 * exit the body takes.
 *
 * handleUserMessage has at least six exits (an early guard return, four in-loop
 * returns, the max-iterations fall-through, and thrown exceptions). Hooking
 * each one individually is how divergence gets introduced: a later edit adds a
 * seventh exit and silently skips the hook. The finalizer's own failures are
 * swallowed — a labeling bug must never break a user's session.
 */
export async function runWithFinalize(
  body: () => Promise<void>,
  finalize: () => void,
): Promise<void> {
  try {
    await body()
  } finally {
    try {
      finalize()
    } catch (e) {
      console.error(`[trajectory] finalize failed: ${e}`)
    }
  }
}
