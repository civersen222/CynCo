import { describe, expect, it } from 'bun:test'
import {
  serializeEvent,
  parseCommand,
  type EngineEvent,
  type TUICommand,
  type SessionReadyEvent,
  type SessionErrorEvent,
  type StreamTokenEvent,
  type MessageCompleteEvent,
  type ToolStartEvent,
  type ToolProgressEvent,
  type ToolCompleteEvent,
  type FileChangeEvent,
  type ApprovalRequestEvent,
  type ContextStatusEvent,
  type ContextWarningEvent,
  type MemoryRecalledEvent,
  type MemoryWrittenEvent,
  type SummaryInjectedEvent,
  type LSPServerInfo,
  type MCPServerInfo,
  type UserMessageCommand,
  type ApprovalResponseCommand,
  type SlashCommand,
  type AbortCommand,
  type FileOpenCommand,
  type ConfigUpdateCommand,
  type ConfigGetCommand,
  type ProfileListCommand,
  type ProfileActivateCommand,
  type ProfileWriteCommand,
  type ProfileValidateCommand,
  type ConfigCurrentEvent,
  type ConfigUpdatedEvent,
  type ProfileListEvent,
  type ProfileValidationEvent,
  type ProfileWrittenEvent,
} from '../../bridge/protocol.js'

// ─── Engine Event Types ──────────────────────────────────────────

describe('protocol types', () => {
  describe('EngineEvent types', () => {
    it('SessionReadyEvent has correct shape', () => {
      const event: SessionReadyEvent = {
        type: 'session.ready',
        model: 'llama3:8b',
        contextLength: 32768,
      }
      expect(event.type).toBe('session.ready')
      expect(event.model).toBe('llama3:8b')
      expect(event.contextLength).toBe(32768)
    })

    it('SessionErrorEvent has correct shape', () => {
      const event: SessionErrorEvent = {
        type: 'session.error',
        error: 'Connection refused',
      }
      expect(event.type).toBe('session.error')
      expect(event.error).toBe('Connection refused')
    })

    it('StreamTokenEvent has correct shape', () => {
      const event: StreamTokenEvent = {
        type: 'stream.token',
        text: 'Hello',
        messageId: 'msg-123',
      }
      expect(event.type).toBe('stream.token')
      expect(event.text).toBe('Hello')
      expect(event.messageId).toBe('msg-123')
    })

    it('StreamTokenEvent messageId is optional', () => {
      const event: StreamTokenEvent = {
        type: 'stream.token',
        text: 'world',
      }
      expect(event.messageId).toBeUndefined()
    })

    it('MessageCompleteEvent has correct shape', () => {
      const event: MessageCompleteEvent = {
        type: 'message.complete',
        messageId: 'msg-456',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }
      expect(event.type).toBe('message.complete')
      expect(event.messageId).toBe('msg-456')
      expect(event.stopReason).toBe('end_turn')
      expect(event.usage?.inputTokens).toBe(100)
      expect(event.usage?.outputTokens).toBe(50)
    })

    it('MessageCompleteEvent usage is optional', () => {
      const event: MessageCompleteEvent = {
        type: 'message.complete',
        messageId: 'msg-789',
        stopReason: null,
      }
      expect(event.usage).toBeUndefined()
      expect(event.stopReason).toBeNull()
    })

    it('ToolStartEvent has correct shape', () => {
      const event: ToolStartEvent = {
        type: 'tool.start',
        toolId: 'tool-1',
        toolName: 'Read',
        input: { file_path: '/tmp/test.txt' },
      }
      expect(event.type).toBe('tool.start')
      expect(event.toolName).toBe('Read')
      expect(event.input).toEqual({ file_path: '/tmp/test.txt' })
    })

    it('ToolProgressEvent has correct shape', () => {
      const event: ToolProgressEvent = {
        type: 'tool.progress',
        toolId: 'tool-1',
        output: 'Reading file...',
      }
      expect(event.type).toBe('tool.progress')
    })

    it('ToolCompleteEvent has correct shape', () => {
      const event: ToolCompleteEvent = {
        type: 'tool.complete',
        toolId: 'tool-1',
        result: { content: 'file contents' },
        isError: false,
      }
      expect(event.type).toBe('tool.complete')
      expect(event.isError).toBe(false)
    })

    it('ToolCompleteEvent isError is optional', () => {
      const event: ToolCompleteEvent = {
        type: 'tool.complete',
        toolId: 'tool-2',
        result: 'ok',
      }
      expect(event.isError).toBeUndefined()
    })

    it('FileChangeEvent has correct shape', () => {
      const event: FileChangeEvent = {
        type: 'file.change',
        path: '/src/app.ts',
        changeType: 'modify',
        diff: '+added line',
      }
      expect(event.type).toBe('file.change')
      expect(event.changeType).toBe('modify')
      expect(event.diff).toBe('+added line')
    })

    it('FileChangeEvent diff is optional', () => {
      const event: FileChangeEvent = {
        type: 'file.change',
        path: '/tmp/new.txt',
        changeType: 'create',
      }
      expect(event.diff).toBeUndefined()
    })

    it('ApprovalRequestEvent has correct shape', () => {
      const event: ApprovalRequestEvent = {
        type: 'approval.request',
        requestId: 'req-1',
        toolName: 'Bash',
        description: 'Run: rm -rf /tmp/old',
        risk: 'high',
      }
      expect(event.type).toBe('approval.request')
      expect(event.risk).toBe('high')
    })

    it('ContextStatusEvent has correct shape', () => {
      const event: ContextStatusEvent = {
        type: 'context.status',
        utilization: 0.75,
        estimatedTokens: 24576,
        contextLength: 32768,
        action: 'proceed',
      }
      expect(event.type).toBe('context.status')
      expect(event.action).toBe('proceed')
    })

    it('ContextWarningEvent has correct shape', () => {
      const event: ContextWarningEvent = {
        type: 'context.warning',
        utilization: 0.9,
        message: 'Context window 90% full',
      }
      expect(event.type).toBe('context.warning')
    })

    it('MemoryRecalledEvent has correct shape', () => {
      const event: MemoryRecalledEvent = {
        type: 'memory.recalled',
        memories: [
          { type: 'WORKING_SOLUTION', content: 'Use Bun.serve() for WS', confidence: 'high' },
        ],
      }
      expect(event.type).toBe('memory.recalled')
      expect(event.memories).toHaveLength(1)
      expect(event.memories[0].confidence).toBe('high')
    })

    it('MemoryRecalledEvent memory confidence is optional', () => {
      const event: MemoryRecalledEvent = {
        type: 'memory.recalled',
        memories: [{ type: 'CODEBASE_PATTERN', content: 'Pattern X' }],
      }
      expect(event.memories[0].confidence).toBeUndefined()
    })

    it('SummaryInjectedEvent has correct shape', () => {
      const event: SummaryInjectedEvent = {
        type: 'summary.injected',
        toolsUsed: ['Edit', 'Bash'],
      }
      expect(event.type).toBe('summary.injected')
      expect(event.toolsUsed).toEqual(['Edit', 'Bash'])
    })

    it('MemoryRecalledEvent includes sessionContext', () => {
      const event: MemoryRecalledEvent = {
        type: 'memory.recalled',
        memories: [{ type: 'WORKING_SOLUTION', content: 'Use ToolExecutor intercept', confidence: 'high' }],
        sessionContext: {
          priorGoal: 'fix edit loop',
          priorStatus: 'in_progress',
          priorDate: '2d ago',
          openThreads: [{ priority: 'high', description: 'wire summary injection' }],
        },
      }
      expect(event.type).toBe('memory.recalled')
      expect(event.sessionContext?.priorGoal).toBe('fix edit loop')
      expect(event.sessionContext?.openThreads).toHaveLength(1)
    })

    it('MemoryRecalledEvent works without sessionContext', () => {
      const event: MemoryRecalledEvent = {
        type: 'memory.recalled',
        memories: [],
      }
      expect(event.sessionContext).toBeUndefined()
    })

    it('SessionReadyEvent includes extended fields', () => {
      const event: SessionReadyEvent = {
        type: 'session.ready',
        model: 'qwen3:8b',
        contextLength: 32768,
        projectPath: '/home/user/myproject',
        version: '0.1.0',
        sessionStartTime: '2026-04-17T10:45:24.115Z',
        lspServers: [
          { language: 'typescript', available: true },
          { language: 'python', available: true },
          { language: 'rust', available: false },
        ],
        mcpServers: [],
      }
      expect(event.projectPath).toBe('/home/user/myproject')
      expect(event.version).toBe('0.1.0')
      expect(event.lspServers).toHaveLength(3)
      expect(event.mcpServers).toHaveLength(0)
    })

    it('SessionReadyEvent works without extended fields (backward compat)', () => {
      const event: SessionReadyEvent = {
        type: 'session.ready',
        model: 'qwen3:8b',
        contextLength: 32768,
      }
      expect(event.projectPath).toBeUndefined()
    })

    it('SessionReadyEvent includes expertise', () => {
      const event: SessionReadyEvent = {
        type: 'session.ready',
        model: 'qwen3:8b',
        contextLength: 32768,
        expertise: 'beginner',
      }
      expect(event.expertise).toBe('beginner')
    })

    it('MemoryWrittenEvent has correct shape', () => {
      const event: MemoryWrittenEvent = {
        type: 'memory.written',
        kind: 'handoff',
        summary: 'Saved handoff: fix edit loop (in_progress)',
      }
      expect(event.type).toBe('memory.written')
      expect(event.kind).toBe('handoff')
      expect(event.summary).toContain('fix edit loop')
    })
  })

  // ─── TUI Command Types ──────────────────────────────────────────

  describe('TUICommand types', () => {
    it('UserMessageCommand has correct shape', () => {
      const cmd: UserMessageCommand = {
        type: 'user.message',
        text: 'Hello, how are you?',
      }
      expect(cmd.type).toBe('user.message')
      expect(cmd.text).toBe('Hello, how are you?')
    })

    it('ApprovalResponseCommand has correct shape', () => {
      const cmd: ApprovalResponseCommand = {
        type: 'approval.response',
        requestId: 'req-1',
        approved: true,
      }
      expect(cmd.type).toBe('approval.response')
      expect(cmd.approved).toBe(true)
    })

    it('SlashCommand has correct shape', () => {
      const cmd: SlashCommand = {
        type: 'command',
        command: 'compact',
        args: '--force',
      }
      expect(cmd.type).toBe('command')
      expect(cmd.command).toBe('compact')
      expect(cmd.args).toBe('--force')
    })

    it('SlashCommand args is optional', () => {
      const cmd: SlashCommand = {
        type: 'command',
        command: 'help',
      }
      expect(cmd.args).toBeUndefined()
    })

    it('AbortCommand has correct shape', () => {
      const cmd: AbortCommand = {
        type: 'abort',
      }
      expect(cmd.type).toBe('abort')
    })

    it('FileOpenCommand has correct shape', () => {
      const cmd: FileOpenCommand = {
        type: 'file.open',
        path: '/src/main.ts',
      }
      expect(cmd.type).toBe('file.open')
      expect(cmd.path).toBe('/src/main.ts')
    })
  })
})

// ─── Helper Functions ────────────────────────────────────────────

describe('serializeEvent', () => {
  it('serializes a SessionReadyEvent to JSON string', () => {
    const event: EngineEvent = {
      type: 'session.ready',
      model: 'qwen3:32b',
      contextLength: 65536,
    }
    const json = serializeEvent(event)
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe('session.ready')
    expect(parsed.model).toBe('qwen3:32b')
    expect(parsed.contextLength).toBe(65536)
  })

  it('serializes a StreamTokenEvent to JSON string', () => {
    const event: EngineEvent = {
      type: 'stream.token',
      text: 'Hello world',
      messageId: 'msg-abc',
    }
    const json = serializeEvent(event)
    expect(typeof json).toBe('string')
    const parsed = JSON.parse(json)
    expect(parsed.text).toBe('Hello world')
  })

  it('serializes a ToolCompleteEvent to JSON string', () => {
    const event: EngineEvent = {
      type: 'tool.complete',
      toolId: 'tool-42',
      result: { lines: ['a', 'b'] },
      isError: false,
    }
    const json = serializeEvent(event)
    const parsed = JSON.parse(json)
    expect(parsed.result).toEqual({ lines: ['a', 'b'] })
  })

  it('serializes a ContextStatusEvent', () => {
    const event: EngineEvent = {
      type: 'context.status',
      utilization: 0.5,
      estimatedTokens: 16384,
      contextLength: 32768,
      action: 'externalize',
    }
    const json = serializeEvent(event)
    const parsed = JSON.parse(json)
    expect(parsed.action).toBe('externalize')
  })
})

describe('parseCommand', () => {
  it('parses a valid UserMessageCommand', () => {
    const json = JSON.stringify({ type: 'user.message', text: 'Hello' })
    const cmd = parseCommand(json)
    expect(cmd).not.toBeNull()
    expect(cmd!.type).toBe('user.message')
    expect((cmd as UserMessageCommand).text).toBe('Hello')
  })

  it('parses a valid ApprovalResponseCommand', () => {
    const json = JSON.stringify({ type: 'approval.response', requestId: 'r1', approved: false })
    const cmd = parseCommand(json)
    expect(cmd).not.toBeNull()
    expect(cmd!.type).toBe('approval.response')
    expect((cmd as ApprovalResponseCommand).approved).toBe(false)
  })

  it('parses a valid SlashCommand', () => {
    const json = JSON.stringify({ type: 'command', command: 'compact' })
    const cmd = parseCommand(json)
    expect(cmd).not.toBeNull()
    expect((cmd as SlashCommand).command).toBe('compact')
  })

  it('parses a valid AbortCommand', () => {
    const json = JSON.stringify({ type: 'abort' })
    const cmd = parseCommand(json)
    expect(cmd).not.toBeNull()
    expect(cmd!.type).toBe('abort')
  })

  it('parses a valid FileOpenCommand', () => {
    const json = JSON.stringify({ type: 'file.open', path: '/test.ts' })
    const cmd = parseCommand(json)
    expect(cmd).not.toBeNull()
    expect((cmd as FileOpenCommand).path).toBe('/test.ts')
  })

  it('returns null for invalid JSON', () => {
    const cmd = parseCommand('not json at all')
    expect(cmd).toBeNull()
  })

  it('returns null for JSON without type field', () => {
    const cmd = parseCommand(JSON.stringify({ text: 'Hello' }))
    expect(cmd).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    const cmd = parseCommand(JSON.stringify('just a string'))
    expect(cmd).toBeNull()
  })

  it('returns null for null JSON', () => {
    const cmd = parseCommand(JSON.stringify(null))
    expect(cmd).toBeNull()
  })

  it('returns null for array JSON', () => {
    const cmd = parseCommand(JSON.stringify([{ type: 'abort' }]))
    expect(cmd).toBeNull()
  })

  it('returns null for empty string', () => {
    const cmd = parseCommand('')
    expect(cmd).toBeNull()
  })
})

// ─── Config/Profile Command Types ────────────────────────────────

describe('Config/Profile command types', () => {
  it('ConfigUpdateCommand has correct shape', () => {
    const cmd: ConfigUpdateCommand = {
      type: 'config.update',
      patches: { temperature: 0.5, maxOutputTokens: 16384 },
    }
    expect(cmd.type).toBe('config.update')
    expect(cmd.patches.temperature).toBe(0.5)
  })
  it('ConfigGetCommand has correct shape', () => {
    const cmd: ConfigGetCommand = { type: 'config.get' }
    expect(cmd.type).toBe('config.get')
  })
  it('ProfileListCommand has correct shape', () => {
    const cmd: ProfileListCommand = { type: 'profile.list' }
    expect(cmd.type).toBe('profile.list')
  })
  it('ProfileActivateCommand has correct shape', () => {
    const cmd: ProfileActivateCommand = { type: 'profile.activate', name: 'coding' }
    expect(cmd.type).toBe('profile.activate')
    expect(cmd.name).toBe('coding')
  })
  it('ProfileWriteCommand has correct shape', () => {
    const cmd: ProfileWriteCommand = { type: 'profile.write', name: 'new-profile', yaml: 'name: new-profile\ntemperature: 0.3' }
    expect(cmd.type).toBe('profile.write')
  })
  it('ProfileValidateCommand has correct shape', () => {
    const cmd: ProfileValidateCommand = { type: 'profile.validate', yaml: 'name: test\ntemperature: 0.3' }
    expect(cmd.type).toBe('profile.validate')
  })
})

// ─── Config/Profile Response Event Types ─────────────────────────

describe('Config/Profile response events', () => {
  it('ConfigCurrentEvent has correct shape', () => {
    const event: ConfigCurrentEvent = {
      type: 'config.current',
      config: { model: 'qwen3:8b', temperature: 0.7, maxOutputTokens: 8192, timeout: 300000, baseUrl: 'http://localhost:11434', contextLength: 32768, tier: 'auto' },
    }
    expect(event.type).toBe('config.current')
    expect(event.config.model).toBe('qwen3:8b')
  })
  it('ConfigUpdatedEvent with success', () => {
    const event: ConfigUpdatedEvent = { type: 'config.updated', applied: { temperature: 0.5 } }
    expect(event.applied.temperature).toBe(0.5)
    expect(event.errors).toBeUndefined()
  })
  it('ConfigUpdatedEvent with errors', () => {
    const event: ConfigUpdatedEvent = { type: 'config.updated', applied: {}, errors: [{ field: 'temperature', message: 'Must be between 0 and 2' }] }
    expect(event.errors).toHaveLength(1)
  })
  it('ProfileListEvent has correct shape', () => {
    const event: ProfileListEvent = { type: 'profile.list', profiles: [{ name: 'coding', scope: 'user', active: true }], parseErrors: [] }
    expect(event.profiles).toHaveLength(1)
  })
  it('ProfileValidationEvent has correct shape', () => {
    const event: ProfileValidationEvent = { type: 'profile.validation', ok: false, errors: ['Missing required field: name'] }
    expect(event.ok).toBe(false)
  })
  it('ProfileWrittenEvent has correct shape', () => {
    const event: ProfileWrittenEvent = { type: 'profile.written', name: 'coding', path: '/home/user/.localcode/profiles/coding.yml' }
    expect(event.name).toBe('coding')
  })
})
