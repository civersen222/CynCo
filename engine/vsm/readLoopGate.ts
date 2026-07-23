import { resolve } from 'node:path'

export type ReadLoopVerdict =
  | { kind: 'allow' }
  | { kind: 'warn'; message: string }
  | { kind: 'deny'; message: string }
  | { kind: 'escalate'; message: string; signatures: string[] }

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Ls'])
const STALL_CAP = 20

function norm(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

export function signature(toolName: string, input: any): string | null {
  switch (toolName) {
    case 'Read': return input?.file_path ? `read:${norm(input.file_path)}` : null
    case 'Grep': return `grep:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}|${input?.glob ?? ''}`
    case 'Glob': return `glob:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}`
    case 'Ls':   return `ls:${norm(input?.path ?? '.')}`
    default:     return null
  }
}

function describe(toolName: string, input: any): string {
  switch (toolName) {
    case 'Read': return input?.file_path ?? 'this file'
    case 'Grep': return `Grep "${input?.pattern ?? ''}"`
    case 'Glob': return `Glob "${input?.pattern ?? ''}"`
    case 'Ls':   return `Ls ${input?.path ?? '.'}`
    default:     return 'this read'
  }
}

export class ReadLoopGate {
  private seen = new Set<string>()
  private warnedRedundant = false
  private warnedStall = false
  private readsSinceWrite = 0
  private consecutiveDenies = 0
  private lastDeniedSig: string | null = null
  private redundantSigs = new Set<string>()
  private static ESCALATE_AFTER = 3

  private denyOrEscalate(sig: string, message: string): ReadLoopVerdict {
    this.redundantSigs.add(sig)
    this.consecutiveDenies = (sig === this.lastDeniedSig) ? this.consecutiveDenies + 1 : 1
    this.lastDeniedSig = sig
    if (this.consecutiveDenies >= ReadLoopGate.ESCALATE_AFTER) {
      return { kind: 'escalate', message, signatures: [...this.redundantSigs] }
    }
    return { kind: 'deny', message }
  }

  evaluate(toolName: string, input: any): ReadLoopVerdict {
    const sig = signature(toolName, input)
    if (sig === null) return { kind: 'allow' }
    this.readsSinceWrite += 1
    if (this.seen.has(sig)) {
      if (!this.warnedRedundant) {
        this.warnedRedundant = true
        return { kind: 'warn', message: `[read-loop] You already read ${describe(toolName, input)} this session. Re-reading the same source rarely surfaces new information. If you have what you need, make an edit now.` }
      }
      return this.denyOrEscalate(sig, `[read-loop] DENIED: you are re-reading sources you've already seen without making any change. You must now either (a) call Write/Edit/MultiEdit to act on what you've learned, or (b) end your turn if the task is genuinely complete. Reading is disabled until you make an edit.`)
    }
    this.seen.add(sig)
    if (this.readsSinceWrite >= STALL_CAP) {
      if (!this.warnedStall) {
        this.warnedStall = true
        return { kind: 'warn', message: `[read-loop] ${this.readsSinceWrite} reads since your last edit. Consider whether you have enough to start implementing — use Write or Edit.` }
      }
      return this.denyOrEscalate(sig, `[read-loop] DENIED: ${this.readsSinceWrite} reads since your last edit with no change made. Make an edit now, or end your turn if complete.`)
    }
    return { kind: 'allow' }
  }

  isDisabled(toolName: string, input: any): boolean {
    const sig = signature(toolName, input)
    if (sig === null) return false
    return this.seen.has(sig) && this.warnedRedundant
  }

  onWrite(): void {
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
    this.consecutiveDenies = 0
    this.lastDeniedSig = null
    this.redundantSigs.clear()
  }

  reset(): void {
    this.seen.clear()
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
    this.consecutiveDenies = 0
    this.lastDeniedSig = null
    this.redundantSigs.clear()
  }
}
