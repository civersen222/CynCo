// engine/daemon/oneShot.ts
// One-shot engine mode: read a task file, run a bounded model+tool loop,
// write a TaskOutcome, return an exit code. Runs INSIDE the engine process
// (invoked from main.ts when --run-task is passed). Loop pattern mirrors
// engine/agents/subAgent.ts but stays independent of it.
import { randomBytes } from 'crypto'
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import type { Message, ContentBlock, ToolUseBlock } from '../types.js'
import { asSystemPrompt } from '../types.js'
import { ToolExecutor } from '../tools/executor.js'
import { getToolByName } from '../tools/registry.js'
import { localCallModel } from '../engine/callModel.js'
import { readTaskFile, writeOutcome } from './taskFile.js'
import type { Recommendation, TaskOutcome } from './types.js'

const MAX_TURNS = 20

export function buildOneShotSystemPrompt(context: string): string {
  return [
    'You are CynCo running an unattended scheduled mission task. There is no user to ask — work autonomously with the tools provided, then stop.',
    '',
    'Mission context:',
    context,
    '',
    'When you are done, end your FINAL message with exactly one fenced code block in this format:',
    '```json',
    '{"summary": "<one-paragraph summary of what you found/did>",',
    ' "recommendations": [{"actionType": "waiver|trade|lineup|info", "summary": "<short>", "detail": "<why>", "deepLink": "<optional URL>"}]}',
    '```',
    'If there is nothing actionable, return an empty recommendations array. Do not invent recommendations.',
  ].join('\n')
}

export function extractOutcome(text: string): TaskOutcome {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(blocks[i])
      if (typeof raw.summary !== 'string') continue
      const recommendations: Recommendation[] = (Array.isArray(raw.recommendations) ? raw.recommendations : [])
        .filter((r: any) => r && typeof r.actionType === 'string' && typeof r.summary === 'string' && typeof r.detail === 'string')
        .map((r: any) => ({
          id: typeof r.id === 'string' && r.id ? r.id : `rec-${randomBytes(4).toString('hex')}`,
          actionType: r.actionType,
          summary: r.summary,
          detail: r.detail,
          ...(typeof r.deepLink === 'string' ? { deepLink: r.deepLink } : {}),
        }))
      return { ok: true, summary: raw.summary, recommendations }
    } catch {
      // try the previous block
    }
  }
  const tail = text.trim().slice(-1000)
  return { ok: true, summary: tail || '(no output)', recommendations: [] }
}

export async function runOneShotTask(
  taskFilePath: string,
  provider: Provider,
  config: LocalCodeConfig,
): Promise<number> {
  let outcomePath = ''
  try {
    const task = readTaskFile(taskFilePath)
    outcomePath = task.outcomePath
    console.log(`[one-shot] Mission ${task.missionId} / trigger ${task.triggerId}`)

    const tools = task.allowedTools
      .map((name) => getToolByName(name))
      .filter((t): t is NonNullable<typeof t> => t != null)
    const allowedNames = new Set(tools.map((t) => t.name))
    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputJSONSchema: t.inputSchema,
    }))

    const executor = new ToolExecutor({
      cwd: process.cwd(),
      requestApproval: async () => true,
      approveAll: true,
    })

    const systemPrompt = asSystemPrompt([buildOneShotSystemPrompt(task.context)])
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: task.prompt }] },
    ]
    const deps = { getProvider: () => provider, loadConfig: () => config }
    const abort = new AbortController()
    const deadline = Date.now() + task.timeoutMs
    let collectedText = ''

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (Date.now() > deadline) {
        writeOutcome(outcomePath, { ok: false, summary: collectedText.slice(-1000), recommendations: [], error: 'Internal deadline exceeded' })
        return 1
      }

      const stream = localCallModel({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: toolDefs,
        signal: abort.signal,
        options: { model: config.model ?? 'unknown' },
        deps,
      })

      // Collect text and tool_use blocks (same event shapes as subAgent.ts)
      let turnText = ''
      const turnToolUses: ToolUseBlock[] = []
      let currentBlock: any = null
      for await (const event of stream) {
        if (event.type !== 'stream_event') continue
        const inner = (event as any).event
        switch (inner.type) {
          case 'content_block_start': {
            const block = inner.content_block
            if (block.type === 'text') currentBlock = { type: 'text', text: '' }
            else if (block.type === 'tool_use') currentBlock = { type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }
            break
          }
          case 'content_block_delta': {
            if (!currentBlock) break
            const delta = inner.delta
            if (delta.type === 'text_delta' && currentBlock.type === 'text') currentBlock.text += delta.text
            else if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
              currentBlock._partialJson = (currentBlock._partialJson ?? '') + delta.partial_json
            }
            break
          }
          case 'content_block_stop': {
            if (!currentBlock) break
            if (currentBlock.type === 'text') turnText += currentBlock.text
            else {
              if (currentBlock._partialJson) {
                try { currentBlock.input = JSON.parse(currentBlock._partialJson) } catch {}
                delete currentBlock._partialJson
              }
              turnToolUses.push({ type: 'tool_use', id: currentBlock.id, name: currentBlock.name, input: currentBlock.input })
            }
            currentBlock = null
            break
          }
        }
      }

      const assistantContent: ContentBlock[] = []
      if (turnText) { assistantContent.push({ type: 'text', text: turnText }); collectedText += turnText + '\n' }
      for (const tu of turnToolUses) assistantContent.push(tu)
      if (assistantContent.length > 0) messages.push({ role: 'assistant', content: assistantContent })

      if (turnToolUses.length === 0) break // model is done

      const toolResults: ContentBlock[] = []
      for (const tu of turnToolUses) {
        if (!allowedNames.has(tu.name)) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: tool "${tu.name}" not allowed for this task`, is_error: true })
          continue
        }
        const result = await executor.execute(tu.name, tu.input)
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.output ?? '', is_error: result.isError === true })
      }
      messages.push({ role: 'user', content: toolResults })
    }

    writeOutcome(outcomePath, extractOutcome(collectedText))
    console.log(`[one-shot] Outcome written: ${outcomePath}`)
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[one-shot] Failed: ${msg}`)
    if (outcomePath) {
      try { writeOutcome(outcomePath, { ok: false, summary: '', recommendations: [], error: msg }) } catch {}
    }
    return 1
  }
}
