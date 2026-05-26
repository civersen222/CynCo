export function capToolResult(output: string, contextLength: number): string {
  const cap = contextLength < 64000 ? 2000 : 4000
  if (output.length <= cap) return output
  const headSize = cap - 500
  const tailSize = 300
  const truncated = output.length - cap
  return output.slice(0, headSize) + `\n...(truncated ${truncated} chars)...\n` + output.slice(-tailSize)
}
