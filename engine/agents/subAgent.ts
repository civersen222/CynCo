/**
 * SubAgent — a forked conversation loop with its own governance.
 *
 * Each sub-agent is a viable system (Beer's VSM S1):
 * - Own CyberneticsGovernance instance
 * - Own ToolExecutor (approveAll for Phase 1 read-only scouts)
 * - Own message history
 * - PRISM persona prompt + vocabulary routing
 *
 * The model loop calls localCallModel, processes stream events to extract
 * text and tool_use blocks, executes tools via the trust-tier-filtered
 * executor, and feeds results back as user messages with tool_result content.
 */

import type { Provider } from '../provider.js'
import type { EngineEvent } from '../bridge/protocol.js'
import type { Message, ContentBlock, ToolUseBlock, ToolDefinition } from '../types.js'
import { asSystemPrompt } from '../types.js'
import type { SubAgentConfig, SubAgentStatus, SubAgentResult } from './types.js'
import { getToolsForTier } from './trustTier.js'
import { AGENT_PERSONAS, buildAgentPrompt } from './prism.js'
import { getVocabulary, formatVocabularyPrompt } from './vocabulary.js'
import { CyberneticsGovernance } from '../vsm/cyberneticsGovernance.js'
import { ToolExecutor } from '../tools/executor.js'
import { getToolByName } from '../tools/registry.js'
import { localCallModel } from '../engine/callModel.js'
import type { LocalCodeConfig } from '../config.js'

// ─── Options ────────────────────────────────────────────────────

export type SubAgentOptions = {
  config: SubAgentConfig
  provider: Provider
  emit: (event: EngineEvent) => void
  cwd: string
  model: string
}

// ─── SubAgent ───────────────────────────────────────────────────

export class SubAgent {
  private config: SubAgentConfig
  private provider: Provider
  private emitEvent: (event: EngineEvent) => void
  private cwd: string
  private model: string
  private governance: CyberneticsGovernance
  private toolExecutor: ToolExecutor
  private aborted = false
  private _status: SubAgentStatus

  constructor(opts: SubAgentOptions) {
    this.config = opts.config
    this.provider = opts.provider
    this.emitEvent = opts.emit
    this.cwd = opts.cwd
    this.model = opts.model

    // Own governance instance — alerts are logged but not escalated in Phase 1
    this.governance = new CyberneticsGovernance()

    // Own tool executor — approveAll since Phase 1 scouts are read-only
    this.toolExecutor = new ToolExecutor({
      cwd: this.cwd,
      requestApproval: async () => true,
      approveAll: true,
    })

    // Initial status
    this._status = {
      id: this.config.id,
      persona: this.config.persona,
      task: this.config.task,
      state: 'queued',
      currentTurn: 0,
      maxTurns: this.config.policyConstraints.maxIterations,
      tokensUsed: 0,
      startTime: Date.now(),
    }
  }

  get id(): string {
    return this.config.id
  }

  get status(): SubAgentStatus {
    return { ...this._status }
  }

  kill(): void {
    this.aborted = true
    this._status.state = 'killed'
    this._status.endTime = Date.now()
  }

  async run(): Promise<SubAgentResult> {
    // Track governance metrics
    let toolCalls = 0
    let toolErrors = 0
    const stuckTurns = 0
    const compactions = 0

    try {
      // 1. Set state to running, emit spawned event
      this._status.state = 'running'
      this._status.startTime = Date.now()
      this.emitEvent({
        type: 'subagent.spawned',
        agentId: this.config.id,
        persona: this.config.persona,
        task: this.config.task,
      })

      // 2. Build system prompt using PRISM + vocabulary
      const persona = AGENT_PERSONAS[this.config.persona] ?? AGENT_PERSONAS.scout
      const vocabulary = getVocabulary(this.config.persona)
      let taskInstruction = this.config.task
      if (vocabulary) {
        taskInstruction = `${formatVocabularyPrompt(vocabulary)}\n\n${taskInstruction}`
      }
      const systemPromptText = buildAgentPrompt(persona, taskInstruction)

      // 3. Build initial messages
      const messages: Message[] = []

      // Add parent context as system-level context if provided
      if (this.config.parentContext) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: `Context from parent agent:\n${this.config.parentContext}` }],
        })
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: 'Understood. I have the context. Proceeding with the task.' }],
        })
      }

      // 4. Add task as initial user message
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: this.config.task }],
      })

      // 5. Get tools via trust tier
      const allowedTools = getToolsForTier(this.config.trustTier, this.config.persona)
      const allowedToolNames = new Set(allowedTools.map(t => t.name))
      const toolDefs: { name: string; description: string; inputJSONSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } }[] = allowedTools.map(t => ({
        name: t.name,
        description: t.description,
        inputJSONSchema: t.inputSchema,
      }))

      // 6. Build callModel deps
      const agentConfig: LocalCodeConfig = {
        model: this.model,
        temperature: 0.7,
        maxOutputTokens: 2048,
        timeout: 60000,
        contextLength: this.config.policyConstraints.maxTokenBudget,
        baseUrl: '',
        tier: 'auto' as const,
        expertise: 'advanced' as const,
        tools: undefined,
        provider: 'ollama' as any,
        apiKey: '',
      }

      const deps = {
        getProvider: () => this.provider,
        loadConfig: () => agentConfig,
      }

      // AbortController for this agent
      const abortController = new AbortController()

      // 7. Model loop (bounded by maxIterations)
      const maxIterations = this.config.policyConstraints.maxIterations
      let collectedText = ''

      for (let turn = 0; turn < maxIterations; turn++) {
        if (this.aborted) break

        this._status.currentTurn = turn + 1

        // Call localCallModel
        const systemPrompt = asSystemPrompt([systemPromptText])
        const stream = localCallModel({
          messages,
          systemPrompt,
          thinkingConfig: { type: 'disabled' },
          tools: toolDefs,
          signal: abortController.signal,
          options: { model: this.model },
          deps,
        })

        // Collect text and tool_use blocks from the stream
        let turnText = ''
        const turnToolUses: ToolUseBlock[] = []
        let currentBlock: any = null
        let outputTokens = 0

        for await (const event of stream) {
          if (this.aborted) {
            abortController.abort()
            break
          }

          // Process stream_event wrappers
          if (event.type === 'stream_event') {
            const inner = (event as any).event
            switch (inner.type) {
              case 'content_block_start': {
                const block = inner.content_block
                if (block.type === 'text') {
                  currentBlock = { type: 'text', text: '' }
                } else if (block.type === 'tool_use') {
                  currentBlock = {
                    type: 'tool_use',
                    id: block.id ?? '',
                    name: block.name ?? '',
                    input: block.input ?? {},
                  }
                }
                break
              }
              case 'content_block_delta': {
                if (!currentBlock) break
                const delta = inner.delta
                if (delta.type === 'text_delta' && currentBlock.type === 'text') {
                  currentBlock.text += delta.text
                } else if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
                  if (!currentBlock._partialJson) currentBlock._partialJson = ''
                  currentBlock._partialJson += delta.partial_json
                }
                break
              }
              case 'content_block_stop': {
                if (currentBlock) {
                  if (currentBlock.type === 'text') {
                    turnText += currentBlock.text
                  } else if (currentBlock.type === 'tool_use') {
                    // Finalize JSON parsing
                    if (currentBlock._partialJson) {
                      try {
                        currentBlock.input = JSON.parse(currentBlock._partialJson)
                      } catch { /* keep existing input */ }
                      delete currentBlock._partialJson
                    }
                    turnToolUses.push({
                      type: 'tool_use',
                      id: currentBlock.id,
                      name: currentBlock.name,
                      input: currentBlock.input,
                    })
                  }
                  currentBlock = null
                }
                break
              }
              case 'message_delta': {
                const usage = inner.usage
                if (usage?.output_tokens) {
                  outputTokens = usage.output_tokens
                }
                break
              }
            }
          }
        }

        if (this.aborted) break

        // Update token tracking
        this._status.tokensUsed += outputTokens

        // Build assistant content blocks
        const assistantContent: ContentBlock[] = []
        if (turnText) {
          assistantContent.push({ type: 'text', text: turnText })
          collectedText += turnText
        }
        for (const toolUse of turnToolUses) {
          assistantContent.push(toolUse)
        }

        // Add assistant response to messages
        if (assistantContent.length > 0) {
          messages.push({ role: 'assistant', content: assistantContent })
        }

        // If no tool calls, agent is done
        if (turnToolUses.length === 0) break

        // Execute each tool call
        const toolResults: ContentBlock[] = []
        for (const toolUse of turnToolUses) {
          toolCalls++

          // Only execute tools that are in the allowed list
          if (!allowedToolNames.has(toolUse.name)) {
            toolErrors++
            this.governance.onToolResult(toolUse.name, false, 0)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: tool "${toolUse.name}" is not allowed for this agent's trust tier`,
              is_error: true,
            })

            this.emitEvent({
              type: 'subagent.tool',
              agentId: this.config.id,
              toolName: toolUse.name,
              status: 'error',
              preview: `Denied: not in trust tier`,
            })
            continue
          }

          const startTime = Date.now()
          const result = await this.toolExecutor.execute(toolUse.name, toolUse.input)
          const latencyMs = Date.now() - startTime

          if (result.isError) toolErrors++

          // Track governance
          this.governance.onToolResult(toolUse.name, !result.isError, latencyMs)

          // Emit tool event with preview
          this.emitEvent({
            type: 'subagent.tool',
            agentId: this.config.id,
            toolName: toolUse.name,
            status: result.isError ? 'error' : 'success',
            preview: result.output.slice(0, 200),
          })

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.output,
            is_error: result.isError,
          })
        }

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResults })
      }

      // 8. Determine final state
      if (this.aborted) {
        this._status.state = 'killed'
      } else {
        this._status.state = 'completed'
      }
      this._status.endTime = Date.now()

      // 9. Build result
      const result: SubAgentResult = {
        agentId: this.config.id,
        success: !this.aborted,
        output: collectedText || '(no output)',
        turns: this._status.currentTurn,
        tokensUsed: this._status.tokensUsed,
        governanceMetrics: {
          toolCalls,
          toolErrors,
          stuckTurns,
          compactions,
        },
      }

      // 10. Emit complete event
      this.emitEvent({
        type: 'subagent.complete',
        agentId: this.config.id,
        success: result.success,
        output: result.output.slice(0, 1000),
        turns: result.turns,
        tokensUsed: result.tokensUsed,
      })

      return result
    } catch (err) {
      // Handle unexpected errors
      this._status.state = 'failed'
      this._status.endTime = Date.now()

      const errorOutput = err instanceof Error ? err.message : String(err)
      const result: SubAgentResult = {
        agentId: this.config.id,
        success: false,
        output: `SubAgent error: ${errorOutput}`,
        turns: this._status.currentTurn,
        tokensUsed: this._status.tokensUsed,
        governanceMetrics: {
          toolCalls,
          toolErrors,
          stuckTurns,
          compactions,
        },
      }

      this.emitEvent({
        type: 'subagent.complete',
        agentId: this.config.id,
        success: false,
        output: result.output.slice(0, 1000),
        turns: result.turns,
        tokensUsed: result.tokensUsed,
      })

      return result
    }
  }
}
