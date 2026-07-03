// engine/vsm/governanceSignal.ts
// Governance stuck-loop signals, delivered as APPENDED conversation messages.
// Previously these were injected by rewriting the system prompt, which
// mutated the prompt prefix and invalidated the llama.cpp checkpoint cache
// on every stuck turn — exactly when long contexts make re-prefill costliest.

export function buildGovernanceSignal(stuck: number): string | null {
  if (stuck < 3) return null
  if (stuck >= 5) {
    return `## GOVERNANCE SIGNAL — CRITICAL (turn ${stuck})\n\n` +
      `CRITICAL: You have been stuck for ${stuck} turns repeating the same actions.\n\n` +
      `You MUST change your approach NOW:\n` +
      `- Do NOT call any tool you have used in the last 5 turns\n` +
      `- Use a DIFFERENT available tool, or change the tool's parameters completely\n` +
      `- If repeated attempts keep failing → try a COMPLETELY different strategy\n` +
      `- If you already have enough information → STOP using tools and produce your final answer\n\n` +
      `YOUR NEXT ACTION MUST BE DIFFERENT FROM YOUR PREVIOUS ACTIONS.`
  }
  return `## GOVERNANCE SIGNAL (turn ${stuck})\n\n` +
    `WARNING: You have been repeating similar actions for ${stuck} turns.\n` +
    `Change your approach: use a different tool or different parameters, or act on what you already know.`
}
