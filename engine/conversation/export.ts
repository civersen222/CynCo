
type Message = { role: string; content: any[] }
type ExportMetadata = { model?: string; timestamp?: string; [key: string]: unknown }

export function exportAsMarkdown(messages: Message[], metadata: ExportMetadata = {}): string {
  const lines: string[] = []
  lines.push(`# Conversation`)
  if (metadata.model) lines.push(`**Model:** ${metadata.model}`)
  if (metadata.timestamp) lines.push(`**Date:** ${metadata.timestamp}`)
  lines.push('', '---', '')

  for (const msg of messages) {
    const role = msg.role === 'user' ? '**You**' : msg.role === 'assistant' ? '**Assistant**' : `**${msg.role}**`
    lines.push(`### ${role}`)
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        lines.push(block.text)
      } else if (block.type === 'tool_use') {
        lines.push(`> Tool: **${block.name}**(${JSON.stringify(block.input).slice(0, 200)})`)
      } else if (block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((b: any) => b.text ?? '').join('')
          : String(block.content ?? '')
        lines.push(`> Result: ${text.slice(0, 500)}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function exportAsJson(messages: Message[], metadata: ExportMetadata = {}): string {
  return JSON.stringify({
    version: 1,
    metadata: { ...metadata, exportedAt: new Date().toISOString() },
    messages,
  }, null, 2)
}

export function importFromJson(json: string): { messages: Message[]; metadata: ExportMetadata } {
  const data = JSON.parse(json)
  return { messages: data.messages ?? [], metadata: data.metadata ?? {} }
}
