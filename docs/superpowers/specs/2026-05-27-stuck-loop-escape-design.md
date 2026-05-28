# Stuck Loop Escape — Escalating Intervention

**Date:** 2026-05-27
**Status:** Approved

## Problem

The local LLM gets stuck repeating the same tool calls for 47+ turns. Detection works (stuckCount increments correctly) but intervention doesn't:
- W3 (the only stuck rule) requires `toolSuccessRate < 0.5` — never fires when model repeats successful Reads
- W3 is WARNING tier (advisory only, emits UI event, never enforced)
- No system prompt injection — the model never sees it's stuck
- Stuck comparison only checks first 100 chars of response text — misses repeated tool calls with slightly different output

## Design

### Escalating Intervention Tiers

| Stuck turns | Tier | Action | Mechanism |
|-------------|------|--------|-----------|
| >= 3 | Nudge | Inject governance signal into system prompt | System prompt injection |
| >= 5 | Restrict | Restrict tools to ones NOT used in last 5 turns | C7 critical S5 rule |
| >= 10 | Redirect | Inject synthetic user message forcing reflection | Synthetic message before model call |
| >= 15 | Halt | End model loop, emit halt to TUI | Break from runModelLoop |

### Change 1: Governance Signal Injection (stuck >= 3)

**File:** `engine/bridge/conversationLoop.ts` (line 608, currently blank comment)

When `stuckCount >= 3`, append to system prompt before model call:

```
## Governance Signal

WARNING: You have been repeating similar actions for {N} turns without progress.

REQUIRED: Change your approach immediately.
- If reading files: stop reading and start writing or editing
- If editing fails: try a different file or approach
- If searching: stop searching and act on what you already know
- Summarize what you know and what specific problem is blocking you
```

Escalation at stuck >= 5 (stronger wording):
```
## Governance Signal — CRITICAL

CRITICAL: You have been stuck for {N} turns. Your tools have been restricted.

You MUST change your approach NOW. Do something completely different from your last 5 actions.
```

### Change 2: C7 Critical Rule (stuck >= 5)

**File:** `engine/s5/ruleBasedS5.ts`

New rule C7, CRITICAL tier:

```typescript
const C7: S5Rule = {
  id: 'C7',
  tier: 'critical',
  name: 'Stuck loop — restrict to unused tools',
  evaluate(input) {
    const gov = input.governance as Record<string, unknown> | undefined
    const stuckTurns = (gov?.stuckTurns as number) ?? 0
    if (stuckTurns >= 5) {
      const recentTools = (gov?.recentToolNames as string[]) ?? []
      const recentSet = new Set(recentTools)
      // Get tools NOT used in last 5 turns
      // ALL_TOOLS from the same registry used by C6 (engine/tools/registry.ts)
      const unusedTools = ALL_TOOLS.filter(t => !recentSet.has(t))
      // Always include at least Edit, Write, Bash — action tools
      const forcedTools = new Set([...unusedTools, 'Edit', 'Write', 'Bash', 'Grep'])
      return {
        tools: [...forcedTools],
        reasoning: `stuck for ${stuckTurns} turns — restricting to unused tools to force new approach`,
      }
    }
    return null
  },
}
```

### Change 3: Fix W3 (remove tool success condition)

**File:** `engine/s5/ruleBasedS5.ts`

Change W3's condition from `stuckTurns >= 5 && toolSuccessRate < 0.5` to just `stuckTurns >= 5`. This makes the warning fire for any stuck state, not just failed-tool stuck states.

### Change 4: Smarter Stuck Detection

**File:** `engine/vsm/cyberneticsGovernance.ts` (lines 456-464)

Add tool call signature tracking alongside response text comparison:

```typescript
// Track last 5 tool call signatures (toolName:primaryArg)
private lastToolSignatures: string[] = []

// In recordToolResult():
const sig = `${toolName}:${primaryArg?.slice(0, 50) ?? ''}`
this.lastToolSignatures.push(sig)
if (this.lastToolSignatures.length > 5) this.lastToolSignatures = this.lastToolSignatures.slice(-5)

// In onTurnComplete(): check BOTH response text AND tool signatures
const uniqueResponses = new Set(this.lastResponses).size
const uniqueToolSigs = new Set(this.lastToolSignatures).size
const isStuck = (this.lastResponses.length >= 3 && uniqueResponses === 1) ||
                (this.lastToolSignatures.length >= 3 && uniqueToolSigs === 1)
```

Also expose recent tool names for C7:

```typescript
getRecentToolNames(): string[] {
  return this.lastToolSignatures.map(sig => sig.split(':')[0])
}
```

### Change 5: Synthetic User Message (stuck >= 10)

**File:** `engine/bridge/conversationLoop.ts`

Before the model call in runModelLoop, when `stuckCount >= 10`:

```typescript
if (this.governance.getStuckCount() >= 10) {
  // Inject synthetic user message to force reflection
  this.messages.push({
    role: 'user',
    content: [{ type: 'text', text:
      'STOP. You have been repeating the same actions for ' +
      this.governance.getStuckCount() + ' turns. ' +
      'Describe in 2-3 sentences: (1) What are you trying to accomplish? ' +
      '(2) What specific problem is preventing progress? ' +
      '(3) What completely different approach could you try?'
    }],
  })
}
```

### Change 6: Hard Halt (stuck >= 15)

**File:** `engine/bridge/conversationLoop.ts`

In runModelLoop, before calling the model:

```typescript
if (this.governance.getStuckCount() >= 15) {
  this.emit({
    type: 'stream.token',
    text: '\n\n---\n**Session halted** — stuck for ' +
      this.governance.getStuckCount() +
      ' turns without progress. Send a message to redirect.\n',
    messageId: '',
  })
  this.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
  break // Exit runModelLoop
}
```

## Expose stuckCount

**File:** `engine/vsm/cyberneticsGovernance.ts`

Add getter:
```typescript
getStuckCount(): number { return this.stuckCount }
```

## Include in GovernanceReport

Add `recentToolNames` to the governance report so S5 rules can access it:

```typescript
// In getReport():
return {
  ...existingFields,
  recentToolNames: this.getRecentToolNames(),
}
```

## Testing

- **Unit test**: stuck detection fires on repeated tool signatures even when response text differs
- **Unit test**: C7 rule fires on stuckTurns >= 5, returns tools excluding recently used ones
- **Unit test**: W3 fires on stuckTurns >= 5 regardless of tool success rate
- **Integration test**: stuck >= 3 injects governance signal into system prompt
- **Integration test**: stuck >= 10 injects synthetic user message
- **Integration test**: stuck >= 15 breaks model loop

## Files Modified

1. `engine/s5/ruleBasedS5.ts` — new C7 rule, fix W3 condition
2. `engine/bridge/conversationLoop.ts` — system prompt injection, synthetic message, hard halt
3. `engine/vsm/cyberneticsGovernance.ts` — tool signature tracking, getRecentToolNames(), getStuckCount(), add recentToolNames to report
4. `engine/vsm/types.ts` — add recentToolNames to GovernanceReport type (if typed)
