/**
 * A test world for the tool-call audit (F242, slice S5): a fake home, a mission folder, a sandbox
 * and a MARKED audit folder, all under one mkdtemp root, and a test context over them. Nothing here
 * resolves or touches the live audit folder. `records()` reads every day file back.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_FILE_RE, AUDIT_MARKER } from '../../audit/toolAudit.js'
import { testContainment, type RunContainment } from '../../containment.js'

export interface AuditWorld {
  root: string
  home: string
  mission: string
  audit: string
  ctx: RunContainment
  /** Every record of every day file, in file order. */
  records(): Array<Record<string, any>>
  /** The text of every day file, joined. */
  text(): string
  /** The path of the day file a record written now would go to (today, n = 0). */
  dayFile(): string
  cleanup(): void
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function auditWorld(opts: { marked?: boolean; runId?: string; kind?: RunContainment['kind'] } = {}): AuditWorld {
  const root = mkdtempSync(join(tmpdir(), 'cynco-audit-world-'))
  const home = join(root, 'home')
  const mission = join(root, 'mission')
  const audit = join(root, 'audit')
  // The sandbox's parent is the sandbox root, which the path check keeps for itself: not the world's root.
  const sb = join(root, 'sandbox', 'run1')
  for (const d of [home, mission, audit, join(sb, 'home'), join(sb, 'tmp'), join(sb, 'scratch')]) mkdirSync(d, { recursive: true })
  if (opts.marked !== false) writeFileSync(join(audit, AUDIT_MARKER), '')
  const ctx = testContainment({
    missionCwd: mission,
    sandbox: { root: sb, home: join(sb, 'home'), tmp: join(sb, 'tmp'), scratch: join(sb, 'scratch') },
    home,
    folders: { state: join(root, 'state'), models: join(root, 'models'), guard: join(root, 'guard'), audit },
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  })
  const files = () => readdirSync(audit).filter(n => AUDIT_FILE_RE.test(n) && statSync(join(audit, n)).isFile()).sort()
  return {
    root, home, mission, audit, ctx,
    records: () => files().flatMap(n => readFileSync(join(audit, n), 'utf-8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))),
    text: () => files().map(n => readFileSync(join(audit, n), 'utf-8')).join(''),
    dayFile: () => join(audit, `${localDate(new Date())}.jsonl`),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  }
}

/** Occupy today's day file with a directory, so no record can be appended to it. */
export function blockDayFile(w: AuditWorld): void {
  mkdirSync(w.dayFile(), { recursive: true })
}
