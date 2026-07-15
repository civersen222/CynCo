type Message = {
  role: 'user' | 'assistant' | 'system'
  content: { type: string; text?: string; [key: string]: unknown }[]
}

export type CompressorConfig = {
  threshold: number
  targetRatio: number
  keepRecent?: number
}

/**
 * S4 Environmental Memory: tracks file operations across compaction boundaries
 * so the model doesn't "forget" what it already read/edited.
 */
export class FileOperationTracker {
  private operations: { path: string; tool: string; timestamp: number }[] = []

  record(path: string, tool: string): void {
    this.operations.push({ path, tool, timestamp: Date.now() })
  }

  getModifiedFiles(): string[] {
    return [...new Set(
      this.operations
        .filter(op => ['Write', 'Edit', 'MultiEdit', 'ApplyPatch'].includes(op.tool))
        .map(op => op.path)
    )]
  }

  getReadFiles(): string[] {
    return [...new Set(
      this.operations
        .filter(op => ['Read', 'Grep', 'Glob'].includes(op.tool))
        .map(op => op.path)
    )]
  }

  serialize(): string {
    return JSON.stringify(this.operations)
  }

  /** Clear the op log — called after a compaction so stale ops don't accrue. */
  reset(): void {
    this.operations = []
  }

  static deserialize(json: string): FileOperationTracker {
    const tracker = new FileOperationTracker()
    try {
      tracker.operations = JSON.parse(json)
    } catch { /* corrupt data */ }
    return tracker
  }
}

export class ContextCompressor {
  private config: CompressorConfig
  private readonly keepRecent: number

  constructor(config: CompressorConfig) {
    this.config = config
    this.keepRecent = config.keepRecent ?? 4
  }

  shouldCompress(messages: Message[], estimatedTokens: number, contextLength: number): boolean {
    if (contextLength === 0) return false
    return (estimatedTokens / contextLength) >= this.config.threshold && messages.length > this.keepRecent * 2
  }

  selectForCompression(messages: Message[], keepRecentPairs: number = this.keepRecent): Message[] {
    const keepCount = keepRecentPairs * 2
    if (messages.length <= keepCount) return []
    return messages.slice(0, messages.length - keepCount)
  }

  /**
   * Tier-0 trim: cheaply shrink oversized tool_result blocks in place BEFORE
   * the LLM summary call, so the summary prompt (and kept tail) stay small.
   * Keeps the head and tail of each block verbatim with a truncation marker.
   */
  tier0Trim(messages: Message[], maxBlockChars = 4000): Message[] {
    return messages.map(msg => ({
      ...msg,
      content: msg.content.map(block => {
        const text = block.text
        if (block.type === 'tool_result' && typeof text === 'string' && text.length > maxBlockChars) {
          const head = text.slice(0, Math.floor(maxBlockChars / 2))
          const tail = text.slice(-Math.floor(maxBlockChars / 2))
          const cut = text.length - maxBlockChars
          return { ...block, text: `${head}\n… [trimmed ${cut} chars] …\n${tail}` }
        }
        return block
      }),
    }))
  }

  /** Pi-mono-style structured summary prompt with file operation tracking. */
  buildStructuredSummaryPrompt(messages: Message[], fileTracker?: FileOperationTracker): string {
    const lines = [
      'Summarize the conversation into a structured context summary.',
      'Use EXACTLY this format:',
      '',
      '## Goal',
      '<what the user is trying to accomplish>',
      '',
      '## Progress',
      '<what has been done so far, bullet points>',
      '',
      '## Files Modified',
      '<list of files that were written/edited>',
      '',
      '## Files Read',
      '<list of files that were read for context>',
      '',
      '## Constraints',
      '<any constraints or requirements discovered>',
      '',
      '## Next Steps',
      '<what needs to happen next>',
      '',
    ]

    if (fileTracker) {
      const modified = fileTracker.getModifiedFiles()
      const read = fileTracker.getReadFiles()
      if (modified.length > 0) lines.push(`Known modified files: ${modified.join(', ')}`)
      if (read.length > 0) lines.push(`Known read files: ${read.join(', ')}`)
      lines.push('')
    }

    lines.push('--- Conversation to summarize ---')
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System'
      const text = msg.content.filter(b => b.type === 'text' && b.text).map(b => (b.text as string).slice(0, 500)).join(' ')
      if (text) lines.push(`${role}: ${text}`)
    }
    lines.push('', '--- End of conversation ---', '', 'Provide the structured summary:')
    return lines.join('\n')
  }

  /** Legacy unstructured prompt (kept for fallback). */
  buildSummaryPrompt(messages: Message[]): string {
    return this.buildStructuredSummaryPrompt(messages)
  }

  /**
   * One-shot compaction: tier-0 trim → select → journal-before-replace →
   * summarize → replace → reset tracker. Callbacks are injected so the loop
   * owns the LLM call and the journal sink; the compressor owns the ordering
   * guarantee (write-before-compact) and the tracker lifecycle.
   */
  async runCompaction(
    messages: Message[],
    fileTracker: FileOperationTracker,
    cb: {
      summarize: (prompt: string) => Promise<string>
      journal: (summary: string, fileOps?: string) => void
      keepRecentPairs?: number
    },
  ): Promise<Message[]> {
    const trimmed = this.tier0Trim(messages)
    const toCompress = this.selectForCompression(trimmed, cb.keepRecentPairs ?? this.keepRecent)
    if (toCompress.length === 0) return messages
    const prompt = this.buildStructuredSummaryPrompt(toCompress, fileTracker)
    const summary = await cb.summarize(prompt)
    // Write-before-compact: persist the summary + file ops to the journal
    // BEFORE we drop the source messages, so a crash mid-compaction is safe.
    cb.journal(summary, fileTracker.serialize())
    const compacted = this.compressMessages(trimmed, summary, fileTracker)
    fileTracker.reset()
    return compacted
  }

  compressMessages(messages: Message[], summary: string, fileTracker?: FileOperationTracker): Message[] {
    const keepCount = this.keepRecent * 2
    const recent = messages.slice(-keepCount)
    const metadata = fileTracker ? `\n\n[File Operations: ${fileTracker.serialize()}]` : ''
    return [{ role: 'system', content: [{ type: 'text', text: `[Context Summary]\n${summary}${metadata}` }] }, ...recent]
  }
}
