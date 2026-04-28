/**
 * Core model-calling function for CynCo.
 *
 * Streams a completion from the Ollama provider and yields events
 * in the OpenAI-compatible streaming format:
 *   1. StreamEvent — wraps each SSE chunk
 *   2. AssistantMessage — assembled when generation completes
 */

import { randomUUID } from 'crypto'
import type { SystemPrompt, ThinkingConfig } from '../types.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../provider.js'
import type { StreamEvent as LocalStreamEvent, ToolDefinition } from '../types.js'
import type { LocalCodeConfig } from '../config.js'
import { OllamaProvider } from '../ollama/client.js'
import { loadConfig as defaultLoadConfig } from '../config.js'
import { resolveCapabilities as defaultResolveCapabilities } from '../ollama/probe.js'
import { buildSimulatedToolPrompt } from '../ollama/simulated.js'
import { convertMessages, convertTools, buildSystemPrompt } from './messageConvert.js'
import type { ToolLike } from './messageConvert.js'
import { translateStream } from './streamTranslator.js'
import { filterTools } from './toolFilter.js'

// ─── Output Types ──────

type AssistantMessage = {
  type: 'assistant'
  uuid: string
  timestamp: string
  message: {
    id: string
    model: string
    role: 'assistant'
    stop_reason: string | null
    stop_sequence: string
    type: 'message'
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    }
    content: unknown[]
    container: null
    context_management: null
  }
  requestId: string | undefined
  [key: string]: unknown
}

type StreamEvent = {
  type: 'stream_event'
  event: unknown
  ttftMs?: number
}

type SystemAPIErrorMessage = {
  type: 'system'
  subtype: 'api_retry'
  [key: string]: unknown
}

type Options = {
  model: string
  [key: string]: unknown
}

// Internal message types
type Message = { type?: string; role?: string; content?: unknown[]; [key: string]: unknown }

// Tool type matching the upstream Tool interface shape
type ToolInput = {
  name: string
  description: string
  inputJSONSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  [key: string]: unknown
}

// ─── Dependency Injection ───────────────────────────────────────

/** Default provider factory — creates OllamaProvider from env or default URL. */
function defaultGetProvider(): Provider {
  const baseUrl = process.env.LOCALCODE_BASE_URL ?? 'http://localhost:11434'
  return new OllamaProvider({ baseUrl })
}

export type CallModelDeps = {
  getProvider?: () => Provider
  loadConfig?: () => LocalCodeConfig
  resolveCapabilities?: (model: string) => ModelCapabilities
}

// ─── Retryable Error Detection ──────────────────────────────────

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as any).code
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
      return true
    }
    // Network-style errors
    if (err.message.includes('fetch failed') || err.message.includes('Connection refused')) {
      return true
    }
  }
  return false
}

// ─── Session Shutdown ──────────────────────────────────────────

let shutdownRegistered = false

function registerShutdownHook() {
  if (shutdownRegistered) return
  shutdownRegistered = true

  const gracefulShutdown = async () => {
    try {
      const { onSessionEnd } = await import('../memory/lifecycle.js')
      const os = await import('os')
      const path = await import('path')
      const crypto = await import('crypto')
      const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
      const baseDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
      await onSessionEnd(baseDir, process.cwd().split('/').pop() || 'unknown', {
        goal: 'Session ended normally',
        now: 'Clean shutdown',
        status: 'complete',
      })
    } catch {
      // Best effort
    }
  }

  process.on('SIGTERM', gracefulShutdown)
  process.on('SIGINT', gracefulShutdown)
  process.on('beforeExit', gracefulShutdown)
}

// ─── Main Function ──────────────────────────────────────────────

export async function* localCallModel({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
  deps,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: readonly ToolInput[]
  signal: AbortSignal
  options: Options
  deps?: CallModelDeps
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  registerShutdownHook()

  // 1. Resolve dependencies
  const provider = (deps?.getProvider ?? defaultGetProvider)()
  const config = (deps?.loadConfig ?? defaultLoadConfig)()
  const resolveCaps = deps?.resolveCapabilities ?? defaultResolveCapabilities

  // 2. Resolve model
  const model = options.model || config.model
  if (!model) {
    throw new Error(
      'No model specified. Set LOCALCODE_MODEL environment variable or pass model in options.'
    )
  }

  // 3. Resolve capabilities
  const capabilities = resolveCaps(model)
  const simulatedToolUse = capabilities.toolUse === 'simulated'
  const noToolUse = capabilities.toolUse === 'none'

  // 3b. Pre-turn context check
  const { checkContextBeforeTurn } = await import('../hooks/contextCheck.js')
  const contextCheck = await checkContextBeforeTurn(messages as any, config)

  if (contextCheck.budget.status === 'exceeded') {
    yield {
      type: 'stream_event' as const,
      event: {
        type: 'context_budget_exceeded',
        utilization: contextCheck.budget.utilization,
        action: contextCheck.action,
      },
    }
  } else if (contextCheck.budget.status === 'warning') {
    yield {
      type: 'stream_event' as const,
      event: {
        type: 'context_budget_warning',
        utilization: contextCheck.budget.utilization,
        action: contextCheck.action,
      },
    }

    // Auto-externalize: create handoff with current state
    try {
      const { onSessionEnd } = await import('../memory/lifecycle.js')
      const os = await import('os')
      const path = await import('path')
      const crypto = await import('crypto')
      const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
      const baseDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
      await onSessionEnd(baseDir, process.cwd().split('/').pop() || 'unknown', {
        goal: 'Auto-externalized at ' + Math.round(contextCheck.budget.utilization * 100) + '% context',
        now: 'Context warning threshold reached',
        status: 'in_progress',
        context_at_exit: contextCheck.budget.utilization,
      })
    } catch {
      // Externalization failed -- continue anyway
    }
  }

  // 4. Convert messages
  const convertedMessages = convertMessages(messages as any)

  // 5. Filter tools by profile scoping, then convert
  const scopedTools = filterTools(tools as readonly ToolInput[], config.tools)
  const toolLikes: ToolLike[] = scopedTools.map(t => ({
    name: t.name,
    description: t.description,
    inputJSONSchema: t.inputJSONSchema,
  }))
  const toolDefs: ToolDefinition[] = convertTools(toolLikes)

  // 6. Build system prompt
  let system = buildSystemPrompt(systemPrompt)

  // 7. Handle simulated tool use: prepend tool prompt to system
  if (simulatedToolUse && toolDefs.length > 0) {
    const simPrompt = buildSimulatedToolPrompt(toolDefs)
    system = simPrompt + '\n\n' + system
  }

  // 7b. Session lifecycle — read ledger on first turn
  let sessionContextForProtocol: any = null
  console.log(`[callModel] Step 7b: session lifecycle check (messages=${messages.length})`)
  if (messages.length <= 2) { // First turn heuristic
    try {
      const { onSessionStart } = await import('../memory/lifecycle.js')
      const os = await import('os')
      const path = await import('path')
      const crypto = await import('crypto')
      const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
      const baseDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
      const state = await onSessionStart(baseDir, process.cwd().split('/').pop() || 'unknown')
      if (state.recentHandoffs.length > 0) {
        const lastHandoff = state.recentHandoffs[state.recentHandoffs.length - 1]
        system += `\n\n## Previous Session Context\nLast session goal: ${lastHandoff.handoff.goal}\nStatus: ${lastHandoff.handoff.status}\nWhat was happening: ${lastHandoff.handoff.now}`
        // Capture for protocol event (TUI sidebar)
        try {
          const { formatSessionContext } = await import('../bridge/memoryEvents.js')
          const fs = await import('fs')
          let handoffDate = new Date()
          try {
            const stat = fs.statSync(lastHandoff.path)
            handoffDate = stat.mtime
          } catch {}
          const highPriorityThreads = state.ledger.open_threads
            .filter(t => t.priority === 'high' || t.priority === 'medium')
            .slice(0, 5)
          sessionContextForProtocol = formatSessionContext(
            lastHandoff.handoff,
            highPriorityThreads,
            handoffDate,
          )
        } catch {}
      }
    } catch {
      // Lifecycle system unavailable
    }
  }

  console.log(`[callModel] Step 7c: memory recall`)
  // 7c. Inject recalled memories (first turn only)
  let recalledMemoriesForProtocol: any[] = []
  try {
    const { recallMemories, formatRecalledMemories } = await import('../memory/recall.js')
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()
    const queryText = lastUserMsg?.content?.map((b: any) => b.text || '').join(' ') || ''
    if (queryText && messages.length <= 2) {
      const memories = await recallMemories(queryText, 5)
      const section = formatRecalledMemories(memories)
      if (section) {
        system = system + '\n\n' + section
      }
      // Capture for protocol event
      try {
        const { formatRecalledForProtocol } = await import('../bridge/memoryEvents.js')
        recalledMemoriesForProtocol = formatRecalledForProtocol(memories)
      } catch {}
    }
  } catch {
    // Memory system unavailable
  }

  // Yield memory data for the conversation loop to emit as protocol events
  // This MUST happen BEFORE the provider.stream() call to satisfy ordering guarantee
  if (recalledMemoriesForProtocol.length > 0 || sessionContextForProtocol) {
    yield {
      type: 'stream_event' as const,
      event: {
        type: 'memory_data',
        memories: recalledMemoriesForProtocol,
        sessionContext: sessionContextForProtocol,
      },
    }
  }

  // 8. Build CompletionRequest
  const request: CompletionRequest = {
    model,
    messages: convertedMessages,
    system,
    temperature: config.temperature,
    // No max_tokens — let the model generate as much as it needs
  }

  // Include tools only for native tool use
  if (!noToolUse && !simulatedToolUse && toolDefs.length > 0) {
    request.tools = toolDefs
  }

  // Include thinking config if enabled
  if (thinkingConfig.type === 'enabled') {
    request.thinking = {
      enabled: true,
      budget_tokens: (thinkingConfig as any).budgetTokens,
    }
  }

  // 9. Stream from provider and translate
  console.log(`[callModel] Streaming from provider with ${convertedMessages.length} messages, ${toolDefs.length} tools`)
  let rawStream: AsyncIterable<LocalStreamEvent>
  try {
    rawStream = provider.stream(request)
  } catch (err) {
    if (isRetryableError(err)) {
      yield {
        type: 'system' as const,
        subtype: 'api_retry' as const,
        message: err instanceof Error ? err.message : String(err),
      }
      return
    }
    throw err
  }

  // 10. Pipe through translateStream
  const translatedStream = translateStream(rawStream, {
    simulatedToolUse,
    model,
  })

  // 11. Process translated events
  let messageId = ''
  let messageModel = model
  let lastAssistantMessage: AssistantMessage | null = null
  const contentBlocks: unknown[] = []
  let currentBlock: Record<string, unknown> | null = null
  let ttftMs: number | undefined

  try {
    for await (const event of translatedStream) {
      // Wrap every event in a stream_event envelope
      const streamEvent: StreamEvent = {
        type: 'stream_event',
        event,
        ...(ttftMs === undefined && event.type === 'content_block_delta'
          ? { ttftMs: 0 }
          : {}),
      }
      yield streamEvent

      // Track time-to-first-token
      if (ttftMs === undefined && event.type === 'content_block_delta') {
        ttftMs = 0 // placeholder — real TTFT would be measured with performance.now()
      }

      // Process specific event types for AssistantMessage assembly
      switch (event.type) {
        case 'message_start': {
          messageId = event.message.id
          messageModel = event.message.model || model
          break
        }

        case 'content_block_start': {
          // Start tracking a new content block
          const block = event.content_block
          if (block.type === 'text') {
            currentBlock = { type: 'text', text: '' }
          } else if (block.type === 'tool_use') {
            currentBlock = {
              type: 'tool_use',
              id: (block as any).id ?? randomUUID(),
              name: (block as any).name ?? '',
              input: (block as any).input ?? {},
            }
          } else if (block.type === 'thinking') {
            currentBlock = {
              type: 'thinking',
              text: (block as any).text ?? '',
            }
          } else {
            currentBlock = { ...block }
          }
          break
        }

        case 'content_block_delta': {
          if (!currentBlock) break
          const delta = event.delta
          if (delta.type === 'text_delta' && currentBlock.type === 'text') {
            currentBlock.text = (currentBlock.text as string) + delta.text
          } else if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
            // Accumulate JSON — for simplicity, try to parse at block stop
            const existing = (currentBlock as any)._partialJson ?? ''
            ;(currentBlock as any)._partialJson = existing + delta.partial_json
          } else if (delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
            currentBlock.text = (currentBlock.text as string) + delta.text
          }
          break
        }

        case 'content_block_stop': {
          if (currentBlock) {
            // Finalize tool_use block: parse accumulated JSON
            if (currentBlock.type === 'tool_use' && (currentBlock as any)._partialJson) {
              try {
                currentBlock.input = JSON.parse((currentBlock as any)._partialJson)
              } catch {
                // Keep existing input if parse fails
              }
              delete (currentBlock as any)._partialJson
            }

            contentBlocks.push({ ...currentBlock })
            currentBlock = null
          }

          // Assemble and yield AssistantMessage
          const assistantMsg: AssistantMessage = {
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
            message: {
              id: messageId,
              model: messageModel,
              role: 'assistant',
              stop_reason: null, // mutated later at message_delta
              stop_sequence: '',
              type: 'message',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              content: [...contentBlocks],
              container: null,
              context_management: null,
            },
            requestId: undefined,
          }

          lastAssistantMessage = assistantMsg
          yield assistantMsg
          break
        }

        case 'message_delta': {
          // Mutate the last AssistantMessage in-place
          if (lastAssistantMessage) {
            lastAssistantMessage.message.stop_reason = (event as any).delta.stop_reason
            const usage = (event as any).usage
            if (usage) {
              if (usage.output_tokens !== undefined) {
                lastAssistantMessage.message.usage.output_tokens = usage.output_tokens
              }
              if (usage.input_tokens !== undefined) {
                lastAssistantMessage.message.usage.input_tokens = usage.input_tokens
              }
            }
          }
          break
        }

        default:
          break
      }
    }
  } catch (err) {
    if (isRetryableError(err)) {
      yield {
        type: 'system' as const,
        subtype: 'api_retry' as const,
        message: err instanceof Error ? err.message : String(err),
      }
      return
    }
    throw err
  }
}
