/**
 * Request/response shaping for the non-tool side query, extracted so it can be
 * tested without a server. F92: every compaction summary between the Qwen3.8
 * cutover and 2026-08-18 came back empty or truncated because this call sent a
 * fixed max_tokens of 200 and left reasoning on. Measured on the live model:
 * at a 5,670-token prompt, max_tokens=200 yields 58 chars of content with
 * finish_reason=length; max_tokens=4000 yields 1,218 chars with finish=stop.
 * Real compaction windows are ~50,000 tokens.
 */
export type SideQueryBodyArgs = {
  prompt: string
  maxTokens: number
  model: string
  system?: string
}

export function buildSideQueryBody(args: SideQueryBodyArgs): {
  model: string
  messages: { role: string; content: string }[]
  max_tokens: number
  temperature: number
  chat_template_kwargs: { enable_thinking: boolean; preserve_thinking: boolean }
} {
  return {
    model: args.model,
    messages: [
      ...(args.system ? [{ role: 'system', content: args.system }] : []),
      // No '/no_think' prefix: that is an Ollama/Qwen2.5 convention and this
      // server's jinja template ignores it. Thinking is turned off below, in
      // the place this template actually reads it from.
      { role: 'user', content: args.prompt },
    ],
    max_tokens: args.maxTokens,
    temperature: 0.3,
    // `enable_thinking: false` is the only off-switch this template has, and it
    // works by prefilling an empty `<think>\n\n</think>` into the generation
    // prompt so the model emits content immediately. `reasoning_effort: 'none'`
    // — the value this plan was written against — is REJECTED by the template
    // with HTTP 400 ("Supported types are xhigh (default), medium, and low"),
    // because reasoning_effort is only consulted when thinking is already on.
    // `preserve_thinking: false` additionally strips prior turns' reasoning out
    // of the rendered prompt, which matters when the side query is handed a
    // conversation to summarize.
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
  }
}

/**
 * Read the assistant text out of an OpenAI-compatible response. The Ollama
 * branch of sideQuery has always fallen back to `thinking`; the llama-cpp
 * branch did not, so a response that put everything in reasoning was discarded.
 */
export function readSideQueryContent(data: unknown): string {
  const msg = (data as { choices?: { message?: { content?: string; reasoning_content?: string } }[] })
    ?.choices?.[0]?.message
  return msg?.content || msg?.reasoning_content || ''
}
