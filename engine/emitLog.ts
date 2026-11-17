/**
 * engine/emitLog.ts — what the engine log says about an event it emits.
 *
 * The engine log is the record a stall, a stuck turn or a missing frame is read
 * back from (`loopWatch.ts`: "what ran is the lines the engine printed just
 * above"), so every emitted event is one line with its type. Two types are left
 * out: a chunk of streamed text and a chunk of streamed thinking. They arrive
 * once per token; on the live phone engine they were 17,319 of the log's last
 * 20,000 lines (2026-11-17), which is what made the lines around a stall hard
 * to find. Nothing reads them, and the loop's `[loop] message_stop, deltas=…`
 * line already says how many chunks an answer had.
 */

const STREAM_CHUNKS = new Set(['stream.token', 'stream.thinking'])

/** The log line for an emitted event of this type, or null when it gets none. */
export function emitLogLine(type: string): string | null {
  return STREAM_CHUNKS.has(type) ? null : `[localcode] Emitting: ${type}`
}
