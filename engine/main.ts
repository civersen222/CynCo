/**
 * CynCo engine entry point.
 *
 * Usage:
 *   LOCALCODE_MODEL=qwen3:8b bun engine/main.ts
 */

// Ensure ripgrep is in PATH on Windows (winget installs it but Bun may not inherit updated PATH)
if (process.platform === 'win32') {
  const rgPaths = [
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WinGet\\Packages\\BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe\\ripgrep-15.1.0-x86_64-pc-windows-msvc`,
    `${process.env.USERPROFILE || ''}\\scoop\\shims`,
    `C:\\Program Files\\ripgrep`,
  ]
  const sep = ';'
  const currentPath = process.env.PATH || ''
  for (const rp of rgPaths) {
    if (rp && !currentPath.includes(rp)) {
      try {
        const fs = require('fs')
        if (fs.existsSync(rp)) {
          process.env.PATH = `${rp}${sep}${currentPath}`
          console.log(`[path] Added ripgrep: ${rp}`)
          break
        }
      } catch {}
    }
  }
}

import { loadConfig } from './config.js'
import type { Provider } from './provider.js'
import { LocalCodeWSServer } from './bridge/server.js'
import type { TUICommand } from './bridge/protocol.js'
import { ConversationLoop } from './bridge/conversationLoop.js'
import { S5Orchestrator } from './s5/orchestrator.js'
import { RuleBasedS5 } from './s5/ruleBasedS5.js'
import { ModelS5 } from './s5/modelS5.js'
import { LSPManager } from './lsp/manager.js'
import { VibeController } from './vibe/controller.js'
import { TemplateLoader } from './prompts/templateLoader.js'
import { initJournal } from './training/decisionJournal.js'

// ─── MCP Discovery (standalone — standalone implementation) ──────

async function discoverMcpServers(): Promise<{ name: string; status: string }[]> {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const servers: { name: string; status: string }[] = []

  // Check user-level and project-level MCP config files
  const configPaths = [
    path.join(os.homedir(), '.cynco', 'mcp_servers.json'),
    path.join(os.homedir(), '.config', 'synco', 'mcp_servers.json'),
    path.join(process.cwd(), '.mcp', 'servers.json'),
    path.join(process.cwd(), '.cynco', 'mcp_servers.json'),
  ]

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const mcpServers = raw.mcpServers ?? raw.servers ?? raw
      if (typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
        for (const [name, config] of Object.entries(mcpServers)) {
          if (!servers.some(s => s.name === name)) {
            const disabled = (config as any).disabled === true
            servers.push({ name, status: disabled ? 'disabled' : 'connected' })
          }
        }
      }
    } catch {}
  }

  return servers
}

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig()

// Migrate ~/.localcode → ~/.cynco if needed
try {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const oldDir = path.join(os.homedir(), '.localcode')
  const newDir = path.join(os.homedir(), '.cynco')
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    fs.renameSync(oldDir, newDir)
    console.log(`[cynco] Migrated state ~/.localcode → ~/.cynco`)
  }
} catch {}

// ─── Provider Setup ──────────────────────────────────────────
import { resolveCapabilities } from './ollama/probe.js'
const modelCaps = config.model ? resolveCapabilities(config.model) : null

let provider: Provider
let contextLength: number

async function createOllamaFallback(): Promise<{ provider: Provider; contextLength: number }> {
  const contextLengthExplicit = process.env.LOCALCODE_CONTEXT_LENGTH
    ? parseInt(process.env.LOCALCODE_CONTEXT_LENGTH, 10)
    : undefined

  let ctx: number
  if (contextLengthExplicit && !Number.isNaN(contextLengthExplicit)) {
    ctx = contextLengthExplicit
    console.log(`[context] Using explicit LOCALCODE_CONTEXT_LENGTH=${ctx}`)
  } else {
    let ollamaNumCtx: number | null = null
    try {
      const resp = await fetch(`${config.baseUrl}/api/ps`)
      const data = await resp.json() as any
      const running = data.models?.find((m: any) => m.name?.startsWith(config.model?.split(':')[0] ?? ''))
      if (running?.details?.num_ctx) {
        ollamaNumCtx = running.details.num_ctx
      }
    } catch {}

    if (ollamaNumCtx) {
      ctx = ollamaNumCtx
      console.log(`[context] Detected Ollama num_ctx=${ctx} from /api/ps`)
    } else {
      const OLLAMA_DEFAULT_CTX = 32768
      const modelMax = modelCaps?.contextLength ?? OLLAMA_DEFAULT_CTX
      ctx = Math.min(modelMax, OLLAMA_DEFAULT_CTX)
      console.log(`[context] Using Ollama default ${ctx} (model theoretical max: ${modelMax})`)
    }
  }

  const { createProvider } = await import('./providers/factory.js')
  return { provider: createProvider('ollama', config.baseUrl, config.apiKey, ctx), contextLength: ctx }
}

if (config.provider === 'llama-cpp') {
  // ─── llama-cpp provider path ─────────────────────────────
  try {
    const os = require('os')
    const path = require('path')

    const cyncoDir = path.join(os.homedir(), '.cynco')
    const binDir = path.join(cyncoDir, 'bin')
    const modelsDir = path.join(cyncoDir, 'models')
    const adaptersDir = path.join(cyncoDir, 'adapters')

    // 1. Resolve llama-server binary
    const { resolveBinary, downloadBinary } = await import('./llama/binaryManager.js')
    let binaryPath = resolveBinary(config.llamaServer, binDir)
    if (!binaryPath) {
      console.log('[llama-cpp] llama-server not found — downloading...')
      binaryPath = await downloadBinary(binDir, (msg) => console.log(msg))
    }
    console.log(`[llama-cpp] Binary: ${binaryPath}`)

    // 2. Resolve GGUF model
    const { resolveModel } = await import('./llama/modelResolver.js')
    const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath)
    console.log(`[llama-cpp] Model: ${modelPath}`)

    // 3. Start/connect to llama-server
    const { ProcessManager } = await import('./llama/processManager.js')
    const processManager = new ProcessManager({
      binaryPath,
      modelPath,
      port: config.port,
      ctxSize: config.contextLength ?? 32768,
      batchSize: config.batchSize,
      gpuLayers: config.gpuLayers,
      flashAttn: config.flashAttn,
      threads: config.threads,
    })
    await processManager.ensureRunning()

    // 4. Create provider
    const { LlamaCppProvider } = await import('./llama/provider.js')
    provider = new LlamaCppProvider({
      primaryUrl: `http://127.0.0.1:${config.port}`,
      adapterUrl: config.adapterUrl,
      modelName: config.model ?? 'unknown',
      modelsDir,
      adaptersDir,
      processManager,
    })

    contextLength = config.contextLength ?? 32768
    config.contextLength = contextLength

    // Cleanup on exit — must run before the later SIGINT/SIGTERM handlers that call process.exit()
    const cleanup = async () => { await processManager.stop() }
    process.on('beforeExit', cleanup)

  } catch (err) {
    console.error(`[llama-cpp] Setup failed: ${err instanceof Error ? err.message : err}`)
    console.log('[llama-cpp] Falling back to Ollama provider')
    const fallback = await createOllamaFallback()
    provider = fallback.provider
    contextLength = fallback.contextLength
    config.contextLength = contextLength
  }

} else {
  // ─── Ollama provider path (existing) ───────────────────────
  const fallback = await createOllamaFallback()
  provider = fallback.provider
  contextLength = fallback.contextLength
  config.contextLength = contextLength
}

console.log(`[localcode] Context budget: ${contextLength} tokens`)
const port = parseInt(process.env.LOCALCODE_WS_PORT ?? '9160', 10)

if (!config.model) {
  console.error('[localcode] No model specified. Set LOCALCODE_MODEL or use a profile.')
  process.exit(1)
}

console.log(`[localcode] Model: ${config.model}`)
const providerUrl = config.provider === 'llama-cpp' ? `http://127.0.0.1:${config.port}` : config.baseUrl
console.log(`[localcode] Provider: ${config.provider} @ ${providerUrl}`)
console.log(`[localcode] Starting WS server on port ${port}...`)

// Auto-detect and install LSP servers
const lspMgr = new LSPManager(process.cwd())
let availableLSPs = lspMgr.detectAvailable()

if (availableLSPs.length === 0) {
  console.log('[cynco] No LSP servers found. For better code intelligence, install:')
  console.log('[cynco]   npm install -g typescript-language-server typescript')
  console.log('[cynco]   pip install python-lsp-server')
  console.log('[cynco] Continuing without LSP support.')
}

if (availableLSPs.length > 0) {
  console.log(`[localcode] LSP servers: ${availableLSPs.map(s => s.language).join(', ')}`)
} else {
  console.log('[localcode] LSP servers: none available (npm/pip not found?)')
}

// ─── S5 Decision Orchestrator ──────────────────────────────────

// L3: If LOCALCODE_S5_MODEL is set, use a LoRA-trained model for S5 decisions
const s5Impl = process.env.LOCALCODE_S5_MODEL
  ? new ModelS5({ model: process.env.LOCALCODE_S5_MODEL, baseUrl: config.baseUrl })
  : new RuleBasedS5()
const s5Orchestrator = new S5Orchestrator(s5Impl)
if (process.env.LOCALCODE_S5_MODEL) {
  console.log(`[cynco] S5 Decision Model: ${process.env.LOCALCODE_S5_MODEL}`)
}

// Initialize decision journal for v2 training data collection
const journal = initJournal()
console.log('[training] Decision journal initialized: ~/.cynco/training/')

// V2 training pipeline threshold checks
try {
  const { GovernanceDB } = await import('./vsm/governanceDb.js')
  const os = require('os')
  const path = require('path')
  const dbPath = path.join(os.homedir(), '.cynco', 'governance', 'governance.db')
  const db = new GovernanceDB(dbPath)
  const sessions = db.getRecentSessions(9999)
  const count = sessions.length
  if (count >= 200) {
    console.log(`[v2] ⚠ ${count} sessions reached — LoRA fine-tuning pipeline due (see docs/superpowers/specs/2026-05-01-v2-bridge-design.md)`)
  } else if (count >= 100) {
    console.log(`[v2] ⚠ ${count} sessions reached — training extraction pipeline due`)
  } else if (count >= 50) {
    console.log(`[v2] ⚠ ${count} sessions reached — decision journals ready to wire`)
  } else {
    console.log(`[v2] ${count} sessions — collecting data (next milestone: 50)`)
  }
  db.close()
} catch (e) {
  console.log(`[v2] Session count check skipped: ${e instanceof Error ? e.message : e}`)
}

// ─── WS Server + Conversation Loop ────────────────────────────

const wsServer = new LocalCodeWSServer({
  port,
  onCommand: (cmd) => {
    console.log(`[localcode] WS command received: ${JSON.stringify(cmd).slice(0, 200)}`)
    handleCommand(cmd).catch(err => {
      console.error('[localcode] Command handler error:', err)
    })
  },
})

// Initialize audit logger
import { AuditLogger } from './audit/auditLogger.js'
const auditSessionId = `session-${Date.now()}`
AuditLogger.init(auditSessionId, process.cwd(), config.model)

// Audit-relevant event prefixes
const AUDIT_EVENT_PREFIXES = ['governance.', 'context.', 's2.', 's5.', 'algedonic.', 'workflow.']

const loop = new ConversationLoop({
  config,
  provider,
  emit: (event) => {
    console.log(`[localcode] Emitting: ${event.type}`)
    wsServer.emit(event)

    // Tee audit-relevant events to the audit log
    const evType = (event as any).type ?? ''
    if (AUDIT_EVENT_PREFIXES.some(p => evType.startsWith(p))) {
      AuditLogger.log('events', { type: evType, data: event })
    }
    // Track tool calls for session-outcomes
    if (evType === 'tool.start') {
      AuditLogger.trackToolCall((event as any).toolName ?? 'unknown')
    }
    // Track context utilization high-water mark
    if (evType === 'context.status') {
      AuditLogger.trackContextUtilization((event as any).utilization ?? 0)
    }
  },
  s5: s5Orchestrator,
})

// Write session outcome on clean shutdown
async function cleanShutdown(signal: string) {
  // Record governance session outcome
  try {
    const govReport = loop.getGovernance?.()?.getReport?.()
    if (govReport && loop.getGovernance?.()?.recordSessionOutcome) {
      const outcome = govReport.stuckTurns >= 5 ? 'non-viable' as const
        : govReport.toolSuccessRate < 0.5 ? 'marginal' as const
        : 'viable' as const
      loop.getGovernance().recordSessionOutcome(outcome, 'default', 0, loop.getFileTracker?.()?.getModifiedFiles?.()?.length ?? 0)
    }
  } catch {}
  // Save S5 rule weights
  try { s5Orchestrator.saveWeights() } catch {}
  AuditLogger.writeSessionOutcome(signal)
  if (config.provider === 'llama-cpp' && provider && 'processManager' in provider) {
    const pm = (provider as any).processManager
    if (pm?.stop) await pm.stop()
  }
  process.exit(0)
}
process.on('SIGTERM', () => cleanShutdown('SIGTERM'))
process.on('SIGINT', () => cleanShutdown('SIGINT'))
})

let vibeController: VibeController | null = null

function getOrCreateVibeController(): VibeController {
  if (!vibeController) {
    vibeController = new VibeController({
      emit: (event) => {
        console.log(`[vibe] Emitting: ${(event as any).type}`)
        wsServer.emit(event as any)
      },
      sideQuery: async (prompt: string) => {
        const resp = await fetch(`${config.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            options: { num_predict: 300, temperature: 0.3 },
            think: false,
            stream: false,
          }),
        })
        const data: any = await resp.json()
        return data.message?.content ?? ''
      },
      loop,
    })
  }
  return vibeController
}

// ─── Command Handler ───────────────────────────────────────────

async function handleCommand(command: TUICommand): Promise<void> {
  switch (command.type) {
    case 'user.message':
      console.log(`[localcode] User message: "${command.text.slice(0, 80)}"`)
      await loop.handleUserMessage(command.text)
      break

    case 'abort':
      loop.abort()
      break

    case 'approval.response':
      loop.handleApprovalResponse(command.requestId, command.approved)
      // Track governance recommendation dismissals for S5 weight tuning
      if (!command.approved && s5Orchestrator) {
        try { s5Orchestrator.recordDismissal([command.requestId]) } catch {}
      }
      break

    case 'command': {
      const cmd = command.command
      const args = command.args ?? ''
      console.log(`[localcode] Slash command: ${cmd} ${args}`)

      switch (cmd) {
        case '/quit':
        case '/exit':
          await wsServer.close()
          process.exit(0)
          break

        case '/model':
          if (args) {
            config.model = args
            loop.updateModel(args)
            wsServer.emit({
              type: 'session.ready',
              model: args,
              contextLength: contextLength,
            })
          }
          break

        case '/approve-all':
          loop.setApproveAll(true)
          wsServer.emit({ type: 'stream.token', text: '[System] Auto-approve enabled for all tools.\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break

        case '/reset':
          loop.resetGovernance()
          wsServer.emit({ type: 'stream.token', text: '[System] Governance reset — kill switch cleared, stuck counter reset. You can continue working.\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break

        case '/context':
          wsServer.emit({ type: 'stream.token', text: '[System] Context status: feature coming in Phase 2.\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break

        case '/compact':
          wsServer.emit({ type: 'stream.token', text: '[System] Compacting context — summarizing conversation history...\n' })
          await loop.handleUserMessage('[System] Summarize our conversation so far in bullet points. Preserve key decisions, file paths, and current goals.')
          break

        case '/tools': {
          const { ALL_TOOLS } = await import('./tools/registry.js')
          const toolInfo = ALL_TOOLS
            .map(t => `  ${t.tier === 'auto' ? '✓' : '⚠'} ${t.name} — ${t.description.slice(0, 60)}`)
            .join('\n')
          wsServer.emit({ type: 'stream.token', text: `Available tools:\n${toolInfo}\n\n✓ = auto-approve, ⚠ = requires approval\n` })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/read':
          if (args) await loop.handleUserMessage(`Read the file at ${args} and show me its contents.`)
          break

        case '/search':
          if (args) await loop.handleUserMessage(`Search the codebase for: ${args}`)
          break

        case '/git':
          await loop.handleUserMessage('Show me the current git status and recent changes.')
          break

        case '/commit':
          await loop.handleUserMessage('Help me create a commit. Show the staged changes and suggest a commit message.')
          break

        case '/diff':
          await loop.handleUserMessage('Show me the current git diff of all modified files.')
          break

        case '/tdd':
        case '/debug':
        case '/review':
        case '/plan':
        case '/brainstorm':
        case '/critique':
        case '/research': {
          const { getWorkflow } = await import('./workflows/index.js')
          const wf = getWorkflow(cmd)
          if (wf) {
            loop.startWorkflow(wf)
            wsServer.emit({ type: 'stream.token', text: `[System] Started workflow: ${wf.displayName}\nPhase: ${wf.initialPhase}\n\n${wf.phases[wf.initialPhase].instruction}\n` })
            wsServer.emit({ type: 'workflow.status', active: true, workflow: wf.name, phase: wf.initialPhase, displayName: wf.displayName })
            wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          }
          break
        }

        case '/cancel': {
          loop.cancelWorkflow()
          wsServer.emit({ type: 'stream.token', text: '[System] Workflow cancelled.\n' })
          wsServer.emit({ type: 'workflow.status', active: false, workflow: null, phase: null, displayName: null })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/cascade': {
          const { classifyComplexity } = await import('./cascade/modelPicker.js')
          const recentToolCount = parseInt(args, 10) || 0
          const sampleMsg = args && isNaN(parseInt(args, 10)) ? args : 'current task'
          const complexity = classifyComplexity(sampleMsg, recentToolCount)
          wsServer.emit({
            type: 'stream.token',
            text: `[Cascade] Task complexity: ${complexity}\nSimple → fast model, Moderate → balanced, Complex → powerful.\n`,
          })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/agent':
          wsServer.emit({ type: 'stream.token', text: '[System] Sub-agent queue coming in Phase 2D.\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break

        case '/s5': {
          const history = s5Orchestrator.decisionHistory
          const last = history.length > 0 ? history[history.length - 1] : null
          const lines = [
            `[S5] Current implementation: ${s5Orchestrator.currentS5Name}`,
            `[S5] Decisions made this session: ${history.length}`,
          ]
          if (last) {
            lines.push(`[S5] Last decision reasoning: ${last.decision.reasoning}`)
            lines.push(`[S5]   contextAction=${last.decision.contextAction} priority=${last.decision.priority} tools=${last.decision.tools ? last.decision.tools.join(',') : 'unrestricted'}`)
          } else {
            lines.push('[S5] No decisions made yet this session.')
          }
          wsServer.emit({ type: 'stream.token', text: lines.join('\n') + '\n' })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/export': {
          const format = args === 'json' ? 'json' : 'markdown'
          const { exportAsMarkdown, exportAsJson } = await import('./conversation/export.js')
          const data = format === 'json'
            ? exportAsJson(loop.getMessages(), { model: config.model })
            : exportAsMarkdown(loop.getMessages(), { model: config.model, timestamp: new Date().toISOString() })
          const fs = await import('fs')
          const filename = `conversation-${Date.now()}.${format === 'json' ? 'json' : 'md'}`
          fs.writeFileSync(filename, data)
          wsServer.emit({ type: 'stream.token', text: `[System] Conversation exported to ${filename}\n` })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/analyze': {
          const { ProjectIndexer } = await import('./index/indexer.js')
          const indexer = new ProjectIndexer(process.cwd(), config.baseUrl)
          wsServer.emit({ type: 'stream.token', text: '[System] Analyzing project...\n' })
          try {
            const result = await indexer.index((msg) => {
              wsServer.emit({ type: 'stream.token', text: `[Index] ${msg}\n` })
            })
            wsServer.emit({ type: 'stream.token', text: `[System] Index complete: ${result.chunks} chunks from ${result.files} files (${result.skipped} unchanged)\n` })
          } catch (err) {
            wsServer.emit({ type: 'stream.token', text: `[System] Index failed: ${err instanceof Error ? err.message : String(err)}\n` })
          } finally {
            indexer.close()
          }
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/audit-start': {
          const parts = args.split(' ')
          const auditModel = parts[0] || config.model || 'unknown'
          const hw = parts.slice(1).join(' ') || 'not specified'
          const wrote = AuditLogger.writeMetadata(auditModel, hw)
          if (wrote) {
            wsServer.emit({ type: 'stream.token', text: `[Audit] Started 4-week audit. Model: ${auditModel}. Hardware: ${hw}\n` })
          } else {
            wsServer.emit({ type: 'stream.token', text: `[Audit] Audit already started. Delete ~/.cynco/audit-log/metadata.json to restart.\n` })
          }
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/audit-summary': {
          AuditLogger.setTaskSummary(args)
          wsServer.emit({ type: 'stream.token', text: `[Audit] Task summary saved: "${args.slice(0, 80)}"\n` })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/audit-result': {
          const success = args.toLowerCase().startsWith('success') || args.toLowerCase().startsWith('pass')
          AuditLogger.setTaskSuccess(success)
          wsServer.emit({ type: 'stream.token', text: `[Audit] Session result: ${success ? 'SUCCESS' : 'FAIL'}\n` })
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        case '/audit-status': {
          const meta = AuditLogger.getMetadata()
          if (!meta) {
            wsServer.emit({ type: 'stream.token', text: `[Audit] No audit running. Use /audit-start <model> <hardware> to begin.\n` })
          } else {
            const startDate = new Date(meta.audit_start_ts as string)
            const daysElapsed = Math.floor((Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000))
            const daysRemaining = Math.max(0, 28 - daysElapsed)
            wsServer.emit({ type: 'stream.token', text: `[Audit] Day ${daysElapsed}/28 (${daysRemaining} remaining). Model: ${meta.model}. Started: ${(meta.audit_start_ts as string).slice(0, 10)}\n` })
          }
          wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          break
        }

        default: {
          // Check for template-based custom commands
          const templateName = cmd.replace('/', '')
          const templates = new TemplateLoader(process.cwd())
          const tmpl = templates.load(templateName)
          if (tmpl) {
            const resolved = templates.substitute(tmpl.content, args)
            console.log(`[template] Loaded "${templateName}" from ${tmpl.source}`)
            await loop.handleUserMessage(resolved)
          } else {
            wsServer.emit({ type: 'stream.token', text: `Unknown command: ${cmd}\n` })
            wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
          }
          break
        }
      }
      break
    }

    case 'config.get': {
      const { handleConfigGet } = await import('./bridge/configHandlers.js')
      wsServer.emit(handleConfigGet(config))
      break
    }

    case 'config.update': {
      const { handleConfigUpdate } = await import('./bridge/configHandlers.js')
      const event = handleConfigUpdate(config, (command as any).patches ?? {})
      wsServer.emit(event)
      break
    }

    case 'profile.list': {
      const { handleProfileList } = await import('./bridge/configHandlers.js')
      wsServer.emit(handleProfileList(process.env.LOCALCODE_PROFILE))
      break
    }

    case 'profile.validate': {
      const { handleProfileValidate } = await import('./bridge/configHandlers.js')
      wsServer.emit(handleProfileValidate((command as any).yaml ?? ''))
      break
    }

    case 'profile.write': {
      const { handleProfileWrite } = await import('./bridge/configHandlers.js')
      const result = handleProfileWrite((command as any).name ?? '', (command as any).yaml ?? '')
      wsServer.emit(result)
      break
    }

    case 'tools.list': {
      const { ALL_TOOLS } = await import('./tools/registry.js')
      const denied = new Set(config.tools?.denied ?? [])
      const allowed = config.tools?.allowed ? new Set(config.tools.allowed) : null
      const tools = ALL_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        tier: t.tier,
        enabled: allowed ? allowed.has(t.name) : !denied.has(t.name),
      }))
      wsServer.emit({ type: 'tools.list', tools })
      break
    }

    case 'web.search': {
      const requestId = (command as any).requestId ?? ''
      const queries: string[] = (command as any).queries ?? []
      console.log(`[search] Searching ${queries.length} queries`)
      const allResults: string[] = []
      for (const query of queries.slice(0, 5)) {
        try {
          const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalCode/0.1)' },
            signal: AbortSignal.timeout(10000),
          })
          const html = await resp.text()
          const snippets = [...html.matchAll(/<a class="result__snippet"[^>]*>(.*?)<\/a>/gs)]
            .map((m: any) => m[1].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim())
            .filter((s: string) => s.length > 20)
            .slice(0, 3)
          if (snippets.length > 0) {
            allResults.push(`Search: "${query}"\n${snippets.join('\n')}\n`)
          }
        } catch (err) {
          console.log(`[search] Failed for "${query}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const resultText = allResults.join('\n') || 'No search results found.'
      console.log(`[search] Got ${allResults.length} result sets, ${resultText.length} chars`)
      wsServer.emit({ type: 'web.search.result', requestId, results: resultText })
      break
    }

    case 'wizard.query': {
      const requestId = (command as any).requestId ?? ''
      const prompt = (command as any).prompt ?? ''
      const systemPrompt = (command as any).systemPrompt ?? ''
      console.log(`[wizard] Query received: ${requestId}`)

      // Emit visible feedback so TUI shows progress
      wsServer.emit({ type: 'stream.token', text: '' })

      const wizardStartMs = Date.now()
      try {
        // Use Ollama native /api/chat (more reliable than /v1/chat/completions)
        // No AbortSignal.timeout — Bun on Windows has issues with it
        // No timeout — let the model take as long as it needs.
        // Gemma4 with large prompts can take 2-5 minutes.
        // The user sees "Thinking..." in the wizard.

        const resp = await fetch(`${config.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              { role: 'user', content: prompt },
            ],
            stream: false,
            think: false,
            options: { temperature: 0.3, num_predict: 4096 },
          }),
        })

        const data = await resp.json() as any
        // Ollama native API returns message.content directly (not choices[])
        // Gemma4 puts everything in message.thinking with empty content — fall back to thinking
        const rawContent = data.message?.content ?? data.choices?.[0]?.message?.content ?? ''
        const text = rawContent || (data.message?.thinking ?? '')
        console.log(`[wizard] OK in ${Date.now() - wizardStartMs}ms: ${text.slice(0, 100)}`)
        wsServer.emit({ type: 'wizard.response', requestId, text })
      } catch (err) {
        console.log(`[wizard] FAILED in ${Date.now() - wizardStartMs}ms: ${err instanceof Error ? err.message : String(err)}`)
        wsServer.emit({
          type: 'wizard.response',
          requestId,
          text: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    case 'profile.activate': {
      const profileName = (command as any).name ?? ''
      process.env.LOCALCODE_PROFILE = profileName
      wsServer.emit({ type: 'stream.token', text: `[System] Profile "${profileName}" will activate on next restart.\n` })
      wsServer.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
      break
    }

    case 'session.end': {
      console.log('[localcode] Received session.end — writing handoff')
      try {
        const { onSessionEnd } = await import('./memory/lifecycle.js')
        const os = await import('os')
        const path = await import('path')
        const crypto = await import('crypto')
        const cwd = process.cwd()
        const projectHash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 8)
        const baseDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
        const project = cwd.split(/[/\\]/).pop() || 'unknown'

        const handoffData = loop.buildHandoff()
        await onSessionEnd(baseDir, project, {
          goal: handoffData.goal,
          now: handoffData.now,
          status: handoffData.status as any,
          model: handoffData.model,
          what_was_done: handoffData.what_was_done,
          files_modified: handoffData.files_modified,
        })
        console.log('[localcode] Handoff written successfully')
      } catch (err) {
        console.log(`[localcode] Handoff failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Record governance session outcome for cross-session learning
      try {
        const govReport = loop.getGovernance?.()?.getReport?.()
        if (govReport && loop.getGovernance?.()?.recordSessionOutcome) {
          const outcome = govReport.stuckTurns >= 5 ? 'non-viable' as const
            : govReport.toolSuccessRate < 0.5 ? 'marginal' as const
            : 'viable' as const
          loop.getGovernance().recordSessionOutcome(outcome, 'default', 0, loop.getFileTracker?.()?.getModifiedFiles?.()?.length ?? 0)
          console.log(`[governance] Session outcome: ${outcome}`)
        }
      } catch (err) {
        console.log(`[governance] Session outcome failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Save S5 rule weights
      try { s5Orchestrator.saveWeights() } catch {}
      // Audit: write session outcome on clean shutdown
      AuditLogger.writeSessionOutcome()
      break
    }

    case 'vibe.start': {
      const ctrl = getOrCreateVibeController()
      const mode = (command as any).mode ?? 'new'
      const description = (command as any).description ?? ''
      console.log(`[vibe] Starting vibe loop: mode=${mode} desc="${description.slice(0, 60)}"`)
      // Auto-index if stale or missing
      try {
        const { ProjectIndexer } = await import('./index/indexer.js')
        const indexer = new ProjectIndexer(process.cwd(), config.baseUrl)
        if (indexer.isStale()) {
          console.log('[vibe] Index stale — auto-indexing...')
          wsServer.emit({ type: 'stream.token', text: '[System] Indexing project for smarter questions...\n' })
          await indexer.index((msg) => console.log(`[index] ${msg}`))
          wsServer.emit({ type: 'stream.token', text: `[System] Index ready: ${indexer.getSummary()}\n` })
        }
        indexer.close()
      } catch (e) {
        console.log(`[vibe] Auto-index failed (non-fatal): ${e}`)
      }
      ctrl.start(mode, description).catch(err => {
        console.error(`[vibe] Start error: ${err}`)
      })
      break
    }

    case 'vibe.answer': {
      const ctrl = getOrCreateVibeController()
      const questionId = (command as any).questionId ?? ''
      const answer = (command as any).answer ?? ''
      console.log(`[vibe] Answer: ${questionId} = "${answer.slice(0, 60)}"`)
      ctrl.handleAnswer(questionId, answer).catch(err => {
        console.error(`[vibe] Answer error: ${err}`)
      })
      break
    }

    case 'vibe.action': {
      const ctrl = getOrCreateVibeController()
      const action = (command as any).action ?? 'done'
      const text = (command as any).text ?? ''
      console.log(`[vibe] Action: ${action}`)
      ctrl.handleAction(action, text).catch(err => {
        console.error(`[vibe] Action error: ${err}`)
      })
      break
    }

    case 'vibe.escalation_response': {
      const ctrl = getOrCreateVibeController()
      const requestId = (command as any).requestId ?? ''
      const action = (command as any).action ?? 'skip'
      console.log(`[vibe] Escalation response: ${action}`)
      ctrl.handleEscalationResponse(requestId, action).catch(err => {
        console.error(`[vibe] Escalation response error: ${err}`)
      })
      break
    }

    default:
      break
  }
}

// ─── Health Check ──────────────────────────────────────────────

provider.healthCheck().then(async ok => {
  if (ok) {
    console.log(`[localcode] ${config.provider} is reachable`)
    const knownLanguages = ['typescript', 'python', 'rust', 'go', 'c']
    const lspServers = knownLanguages.map(lang => ({
      language: lang,
      available: availableLSPs.some((a: any) => a.language === lang),
    }))

    wsServer.emit({
      type: 'session.ready',
      model: config.model!,
      contextLength: contextLength,
      projectPath: process.cwd(),
      version: '0.1.0',
      sessionStartTime: new Date().toISOString(),
      lspServers,
      mcpServers: await discoverMcpServers(),
      expertise: config.expertise,
    })

    // Auto-index project on startup — powers CodeIndex tool in ALL modes
    try {
      const { ProjectIndexer } = await import('./index/indexer.js')
      const indexer = new ProjectIndexer(process.cwd(), config.baseUrl)
      if (indexer.isStale()) {
        console.log('[localcode] Auto-indexing project for CodeIndex tool...')
        await indexer.index((msg) => console.log(`[index] ${msg}`))
        console.log(`[localcode] Index ready: ${indexer.getSummary()}`)
      } else {
        console.log(`[localcode] Index up to date: ${indexer.getSummary()}`)
      }
      indexer.close()
    } catch (e) {
      console.log(`[localcode] Auto-index failed (non-fatal): ${e}`)
    }
  } else {
    console.error(`[localcode] ✗ ${config.provider} NOT reachable at ${providerUrl}`)
    wsServer.emit({
      type: 'session.error',
      error: `${config.provider} not reachable at ${providerUrl}. Is it running?`,
    })
  }
})

console.log(`[localcode] Ready. Waiting for TUI connection on ws://localhost:${port}`)

// Keep process alive
setInterval(() => {}, 60_000)
