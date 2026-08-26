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
type FileOperation = { path: string; tool: string; timestamp: number }

const MODIFYING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ShellWrite']
const READING_TOOLS = ['Read', 'Grep', 'Glob']

function pathsFor(ops: FileOperation[], tools: string[]): string[] {
  return [...new Set(ops.filter(op => tools.includes(op.tool)).map(op => op.path))]
}

export class FileOperationTracker {
  /** Operations since the last compaction. */
  private operations: FileOperation[] = []
  /**
   * Operations from before it. The tracker answers two questions with opposite
   * lifetimes: the summary prompt asks about the window it is summarizing, and
   * every measurement consumer asks about the whole task. `reset()` used to
   * throw the first window away, which answered the summary's question and
   * silently destroyed the answer to everyone else's.
   */
  private archived: FileOperation[] = []

  record(path: string, tool: string): void {
    this.operations.push({ path, tool, timestamp: Date.now() })
  }

  /** Files modified in the current compaction window only — for the summary. */
  getModifiedFilesThisWindow(): string[] {
    return pathsFor(this.operations, MODIFYING_TOOLS)
  }

  /** Files read in the current compaction window only — for the summary. */
  getReadFilesThisWindow(): string[] {
    return pathsFor(this.operations, READING_TOOLS)
  }

  /**
   * Files this session modified.
   *
   * 'ShellWrite' is not a tool the model can call. It is the label the
   * conversation loop attaches to a path that git observed changing across a
   * Bash call — the only way a shell mutation can be seen, since the four
   * editing tools are the only ones that announce a file_path.
   *
   * Measured on the L3-3.3 run: 193 lines were added to a test file via
   * `Add-Content` and `python -c "open(...,'w')"`, and this method returned an
   * empty list. Both consumers were wrong as a result — the filesTouched state
   * feature recorded in every training row, and diffClean, which asks this
   * method whether a dirty path was the agent's own doing and so charged the
   * agent for work it had honestly done.
   *
   * Spans the whole task, compactions included. Measured on L3-3.3 run 2: this
   * read 2 until the single compaction at turn 79 and 0 for every training row
   * after it. The claim is about the task, so the window it was last summarized
   * in cannot be allowed to bound it.
   */
  getModifiedFiles(): string[] {
    return pathsFor([...this.archived, ...this.operations], MODIFYING_TOOLS)
  }

  /** Files this session read, across the whole task. */
  getReadFiles(): string[] {
    return pathsFor([...this.archived, ...this.operations], READING_TOOLS)
  }

  /**
   * The whole task, not the current window — this feeds the crash-safety
   * journal at runCompaction, and a restore that dropped everything before the
   * last compaction would reopen the same hole.
   */
  serialize(): string {
    return JSON.stringify([...this.archived, ...this.operations])
  }

  /**
   * Close the current compaction window. The ops are archived rather than
   * dropped: the summary prompt stops seeing them, every measurement consumer
   * still does.
   */
  reset(): void {
    this.archived.push(...this.operations)
    this.operations = []
  }

  /**
   * Restores the whole log into the current window, so the window/archive
   * boundary does not survive a round trip. Only the next summary prompt can
   * tell the difference, and it would be listing files that really were touched
   * — the safe direction to be wrong in.
   */
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
      // The window being summarized, not the whole task: this prompt describes
      // one compaction's worth of conversation, and re-listing every file from
      // earlier windows would attribute that work to this one.
      const modified = fileTracker.getModifiedFilesThisWindow()
      const read = fileTracker.getReadFilesThisWindow()
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
  /**
   * Verbatim anchors survive compaction: the last <=maxUserMsgs user messages
   * plus (optionally) the active DoD contract brief, rendered as pinned system
   * messages so the literal ask and the contract are never summarized away.
   */
  selectVerbatimAnchors(messages: Message[], contractText?: string, maxUserMsgs = 6): Message[] {
    const anchors: Message[] = []
    if (contractText && contractText.trim()) {
      anchors.push({ role: 'system', content: [{ type: 'text', text: `[Pinned Contract]\n${contractText}` }] })
    }
    const textOf = (m: Message) =>
      m.content.filter(b => b.type === 'text' && b.text).map(b => b.text as string).join(' ')
    // F129: the ORIGINAL task is user message #1, and `.slice(-maxUserMsgs)`
    // can never reach it once tool traffic has pushed it out. CivKings C3 lost
    // three full missions to this: each compaction replaced the 12KB brief with
    // a paraphrase, and by the third cycle "rename the orders to the spec's
    // names" had drifted to "rename the window title". The first user message
    // with real text is the mission and is pinned verbatim, always.
    // Pinned as a real `user` turn even when the contract carries the same
    // text: a compacted conversation whose only user content is a system-role
    // anchor is the "no user query" shape that 400s Qwen's template (below).
    const allUserMsgs = messages.filter(m => m.role === 'user')
    const first = allUserMsgs.find(m => textOf(m))
    if (first) {
      anchors.push({ role: 'user', content: [{ type: 'text', text: `[Pinned original task]\n${textOf(first)}` }] })
    }
    const userMsgs = allUserMsgs.slice(-maxUserMsgs).filter(m => m !== first)
    for (const u of userMsgs) {
      const text = textOf(u)
      // Pinned as `user`, not `system`. Every real user turn ends up either
      // summarized away or held in the tail as a tool_result, and Qwen's chat
      // template scans backwards for a user message that is not a bare
      // <tool_response> — finding none, it raised and llama-server answered 400
      // mid-run. A compacted conversation with no user turn is malformed for any
      // template, so the anchor restores the thing that went missing rather than
      // describing it.
      if (text) anchors.push({ role: 'user', content: [{ type: 'text', text: `[Pinned user request]\n${text}` }] })
    }
    return anchors
  }

  async runCompaction(
    messages: Message[],
    fileTracker: FileOperationTracker,
    cb: {
      summarize: (prompt: string) => Promise<string>
      journal: (summary: string, fileOps?: string) => void
      keepRecentPairs?: number
      contractText?: string
      /**
       * The task's own commits, subject and touched paths, as measured from
       * git. Undefined means not measured and prints nothing; the empty string
       * is the measured claim that nothing has been committed yet.
       */
      commitLog?: string
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
    const anchors = this.selectVerbatimAnchors(messages, cb.contractText)
    // Finding (x): the summary is a paraphrase of the conversation, and the one
    // fact the agent most needs on the far side of a compaction — what it has
    // already committed — is a fact about the repository, not the conversation.
    // Pinned verbatim so no summarizer can drop or soften it.
    if (cb.commitLog !== undefined) {
      const body = cb.commitLog.trim()
        ? cb.commitLog.trim()
        : 'no commits yet — nothing you have done in this task is on disk'
      anchors.push({
        role: 'system',
        content: [{ type: 'text', text: `[Committed so far in this task]\n${body}` }],
      })
    }
    fileTracker.reset()
    // Splice anchors right after the summary system message (index 0).
    return [compacted[0], ...anchors, ...compacted.slice(1)]
  }

  compressMessages(messages: Message[], summary: string, fileTracker?: FileOperationTracker): Message[] {
    const keepCount = this.keepRecent * 2
    const recent = messages.slice(-keepCount)
    const metadata = fileTracker ? `\n\n[File Operations: ${fileTracker.serialize()}]` : ''
    return [{ role: 'system', content: [{ type: 'text', text: `[Context Summary]\n${summary}${metadata}` }] }, ...recent]
  }
}
