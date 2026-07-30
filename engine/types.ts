/**
 * Internal type system for CynCo.
 *
 * Content blocks, discriminated stream events, and tool definitions
 * following the OpenAI-compatible format used by Ollama.
 */

// ─── System Prompt (branded type) ────────────────────────────────

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

// ─── Thinking Config ─────────────────────────────────────────────

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

// ─── Content Blocks ──────────────────────────────────────────────

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; text: string }
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string }

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: ContentBlock[] | string
  is_error?: boolean
}

export type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export type DocumentBlock = {
  type: 'document'
  source:
    | { type: 'base64'; media_type: 'application/pdf'; data: string }
    | { type: 'text'; text: string }
    | { type: 'url'; url: string }
}

export type ConnectorTextBlock = { type: 'connector_text'; text: string }

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | ConnectorTextBlock

// ─── Messages ────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system'

export type Message = {
  role: Role
  content: ContentBlock[]
}

// ─── Completion ──────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  thinking_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  server_tool_use?: { web_search_requests?: number }
  speed?: string
  cost?: TurnCost
}

/**
 * What one turn actually cost, as reported by the server.
 *
 * `input_tokens` above is the size of the prompt; it is NOT what the prompt cost.
 * llama-server reports both: a turn with `prompt_tokens: 11` can have
 * `cache_n: 7, prompt_n: 4` — eleven tokens of context, four tokens of work. For
 * context accounting the first number is right and for cost accounting the second
 * is, and conflating them makes a cached 60k-token prefix look identical to a
 * cold one.
 *
 * Every field is nullable and `source` says which server produced them. A server
 * that reports no timings yields nulls, never zeros: zero prefill milliseconds is
 * a claim that the prefill was free.
 */
export type TurnCost = {
  /** Tokens actually evaluated (llama.cpp `timings.prompt_n`). */
  prefillTokens: number | null
  /** Tokens served from KV cache (`timings.cache_n`). */
  cachedTokens: number | null
  /** Tokens generated (`timings.predicted_n`). */
  decodeTokens: number | null
  prefillMs: number | null
  decodeMs: number | null
  /** Engine-measured round trip. Includes queueing the server cannot see. */
  wallMs: number | null
  /** llama-server KV slot. Not present in the OpenAI-compatible response, so null
   *  until something queries `/slots`; the column exists for the affinity work. */
  slot: number | null
  /**
   * 'server-timings' — llama.cpp `timings` block, everything measured.
   * 'usage-only'     — token counts only; no timing was reported.
   * 'none'           — the server said nothing about cost.
   */
  source: 'server-timings' | 'usage-only' | 'none'
}

export type CompletionResponse = {
  id: string
  model: string
  content: ContentBlock[]
  stop_reason: StopReason
  usage: TokenUsage
}

// ─── Streaming ───────────────────────────────────────────────────

/** Per-sampled-token logprob info parsed from OpenAI-compat `choices[].logprobs.content`. */
export type TokenLogprob = {
  token: string
  logprob: number
  top: { token: string; logprob: number }[]
}

export type ContentDelta =
  | { type: 'text_delta'; text: string; logprobs?: TokenLogprob[] }
  | { type: 'thinking_delta'; thinking: string; logprobs?: TokenLogprob[] }
  | { type: 'input_json_delta'; partial_json: string; logprobs?: TokenLogprob[] }
  | { type: 'connector_text_delta'; text: string }

/** Stream-level content block — may carry optional logprobs for the tool-name token. */
export type StreamContentBlock = ContentBlock & { logprobs?: TokenLogprob[] }

export type StreamEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage: TokenUsage } }
  | { type: 'content_block_start'; index: number; content_block: StreamContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: Partial<TokenUsage> }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } }

// ─── Tool Schema ─────────────────────────────────────────────────

export type ToolInputSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  input_schema: ToolInputSchema
}

// ─── Type Guards ─────────────────────────────────────────────────

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking'
}

export function isRedactedThinkingBlock(block: ContentBlock): block is RedactedThinkingBlock {
  return block.type === 'redacted_thinking'
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

export function isConnectorTextBlock(block: ContentBlock): block is ConnectorTextBlock {
  return block.type === 'connector_text'
}
