/**
 * CynCo Engine — Usage tracking utilities
 *
 * Tracks token usage (input, output, cache) across model calls.
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Non-nullable usage type matching the shape used throughout the codebase.
 * Defined locally to avoid the broken sdkUtilityTypes.ts -> logging.ts chain.
 */
export type NonNullableUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: { web_search_requests: number; web_fetch_requests: number }
  service_tier: string
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string
  iterations: unknown[]
  speed: string
}

// ─── Constants ──────────────────────────────────────────────────

/** Zero-initialized usage constant. Matches services/api/emptyUsage.ts shape. */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}

// ─── Functions ──────────────────────────────────────────────────

/**
 * Merge a streaming usage delta into a running total.
 *
 * Key invariant (LOAD-BEARING): input_tokens, cache_creation_input_tokens,
 * and cache_read_input_tokens are only overwritten when the incoming value
 * is non-null AND > 0. This prevents `message_delta` events (which send
 * explicit `0`) from clobbering real values set by `message_start`.
 *
 * output_tokens, server_tool_use, cache_creation, iterations, and speed
 * take the incoming value via `??` fallback.
 *
 * service_tier and inference_geo always carry over from the existing usage
 * (not the delta).
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: Partial<NonNullableUsage> | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    // > 0 guard: prevent message_delta zeroes from clobbering real values
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens !== undefined && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens !== undefined &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens !== undefined &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    // output_tokens takes incoming value unconditionally via ??
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    // service_tier and inference_geo always carry over from existing usage
    service_tier: usage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        partUsage.cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        partUsage.cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: partUsage.speed ?? usage.speed,
  }
}

/**
 * Sum usage across multiple assistant turns.
 *
 * Numeric token counts are added together. Non-summable fields
 * (service_tier, inference_geo, iterations, speed) take the most
 * recent value from messageUsage.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: messageUsage.inference_geo,
    iterations: messageUsage.iterations,
    speed: messageUsage.speed,
  }
}
