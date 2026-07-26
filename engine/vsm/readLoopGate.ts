import { resolve, sep } from 'node:path'

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
    // The signature must include every parameter that changes what content comes
    // back, or a legitimate second look gets denied as a re-read. Paging a long
    // file (offset 0, then offset 100) and escalating a Grep from a file list to
    // matching lines are both *new* information, not loops.
    case 'Read': return input?.file_path ? `read:${norm(input.file_path)}|${input?.offset ?? ''}|${input?.limit ?? ''}` : null
    case 'Grep': return `grep:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}|${input?.glob ?? ''}|${input?.type ?? ''}|${input?.output_mode ?? ''}|${input?.head_limit ?? ''}|${input?.offset ?? ''}|${input?.['-C'] ?? input?.['-A'] ?? input?.['-B'] ?? ''}`
    case 'Glob': return `glob:${input?.pattern ?? ''}|${norm(input?.path ?? '.')}`
    case 'Ls':   return `ls:${norm(input?.path ?? '.')}`
    default:     return null
  }
}

/**
 * The filesystem location a read is scoped to: the file for Read, the search
 * root for Grep/Glob/Ls. Used to decide which remembered reads a write
 * invalidates.
 */
function scopeOf(toolName: string, input: any): string | null {
  switch (toolName) {
    case 'Read': return input?.file_path ? norm(input.file_path) : null
    case 'Grep': return norm(input?.path ?? '.')
    case 'Glob': return norm(input?.path ?? '.')
    case 'Ls':   return norm(input?.path ?? '.')
    default:     return null
  }
}

function covers(scope: string, written: string): boolean {
  return written === scope || written.startsWith(scope.endsWith(sep) ? scope : scope + sep)
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
  // signature -> the filesystem scope it covers, so a write can un-see it.
  private seen = new Map<string, string>()
  private warnedRedundant = false
  private warnedStall = false
  private readsSinceWrite = 0
  private consecutiveDenies = 0
  private lastDeniedSig: string | null = null
  private redundantSigs = new Set<string>()
  // Reads the model kept demanding after a warn and repeated denials. Once a
  // signature lands here the gate stops refusing it — see relent note below.
  private relented = new Set<string>()
  private static ESCALATE_AFTER = 3

  private denyOrEscalate(sig: string, message: string): ReadLoopVerdict {
    this.redundantSigs.add(sig)
    this.consecutiveDenies = (sig === this.lastDeniedSig) ? this.consecutiveDenies + 1 : 1
    this.lastDeniedSig = sig
    if (this.consecutiveDenies >= ReadLoopGate.ESCALATE_AFTER) {
      this.relented.add(sig)
      return { kind: 'escalate', message, signatures: [...this.redundantSigs] }
    }
    return { kind: 'deny', message }
  }

  evaluate(toolName: string, input: any): ReadLoopVerdict {
    const sig = signature(toolName, input)
    if (sig === null) return { kind: 'allow' }
    this.readsSinceWrite += 1
    // A read that survived a warning and repeated denials is one the model
    // provably cannot proceed without. Keep refusing it and the damage inverts:
    // Edit needs an exact `old_string`, so a blinded model cannot perform the
    // very action the denial message orders it to perform. Nagging is the right
    // lever here; blocking is not. Serve it.
    if (this.relented.has(sig)) return { kind: 'allow' }
    if (this.seen.has(sig)) {
      if (!this.warnedRedundant) {
        this.warnedRedundant = true
        return { kind: 'warn', message: `[read-loop] You already read ${describe(toolName, input)} this session. Re-reading the same source rarely surfaces new information. If you have what you need, make an edit now.` }
      }
      return this.denyOrEscalate(sig, `[read-loop] DENIED: you are re-reading sources you've already seen without making any change. You must now either (a) call Write/Edit/MultiEdit to act on what you've learned, or (b) end your turn if the task is genuinely complete. Reading is disabled until you make an edit.`)
    }
    this.seen.set(sig, scopeOf(toolName, input) ?? '')
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

  /**
   * Re-arm the gate after the model changed something. When the written path is
   * known, forget every remembered read that covered it: the bytes on disk are
   * no longer the bytes the model saw, so looking again is new information, not
   * a loop. Without this the gate blinds the model to its own edit — and since
   * Edit needs an exact `old_string`, a blinded model cannot make the next one.
   */
  onWrite(writtenPath?: string): void {
    if (writtenPath) {
      const written = norm(writtenPath)
      for (const [sig, scope] of this.seen) {
        if (scope && covers(scope, written)) this.seen.delete(sig)
      }
    }
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
    this.consecutiveDenies = 0
    this.lastDeniedSig = null
    this.redundantSigs.clear()
    this.relented.clear()
  }

  reset(): void {
    this.seen.clear()
    this.readsSinceWrite = 0
    this.warnedRedundant = false
    this.warnedStall = false
    this.consecutiveDenies = 0
    this.lastDeniedSig = null
    this.redundantSigs.clear()
    this.relented.clear()
  }
}
