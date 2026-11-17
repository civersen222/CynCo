/**
 * engine/providers/names.ts — which provider names CynCo has, and the refusal
 * for one it does not. No imports, so `engine/config.ts` can read a name
 * without loading a provider.
 *
 * Until 2026-11-17 the type also named `lmstudio`, `llamacpp`, `vllm` and
 * `openai-compat`. None of them was ever built: `bootstrapProvider` has two
 * paths, llama.cpp and "everything else", and everything else is the Ollama
 * client. A profile that said `vllm` ran the Ollama client against its base
 * URL and nothing said so. The owner's decision (decision sheet row 4): the
 * names come out, and a name CynCo does not have is refused where the
 * configuration is read.
 */
export const PROVIDER_TYPES = ['ollama', 'llama-cpp'] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

/** Names that were accepted until 2026-11-17 and ran the Ollama client. */
const RAN_AS_OLLAMA = new Set(['lmstudio', 'vllm', 'openai-compat'])

/**
 * The provider a configured name asks for, or why CynCo has no such provider,
 * with what to set instead. Pure; the caller decides how to refuse.
 */
export function providerFromName(raw: string): { ok: true; provider: ProviderType } | { ok: false; reason: string } {
  const name = raw.trim()
  const known = PROVIDER_TYPES.find(p => p === name)
  if (known) return { ok: true, provider: known }
  const has = 'CynCo has "llama-cpp" (its own llama-server) and "ollama"'
  if (name === 'llamacpp') {
    return { ok: false, reason: `provider "llamacpp" is not one of CynCo's: its own llama-server is spelled "llama-cpp". ${has}.` }
  }
  if (RAN_AS_OLLAMA.has(name)) {
    return {
      ok: false,
      reason: `provider "${name}" is not one of CynCo's. ${has}. Until 2026-11-17 this name was accepted and ran the Ollama client against LOCALCODE_BASE_URL without saying so; set the provider to "ollama" with the same base URL to keep exactly that.`,
    }
  }
  return { ok: false, reason: `provider "${name}" is not one of CynCo's. ${has}. Set LOCALCODE_PROVIDER, or \`provider:\` in the profile, to one of them.` }
}
