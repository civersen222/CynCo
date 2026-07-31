// engine/skills/install.ts
// `/skill install <owner>/<repo>[/<subdir>][@<ref>]` — fetches a skill from a
// public GitHub repo as a zipball (no git binary required, mirrors
// engine/research/engines/github.ts's unauthenticated fetch), extracts it,
// validates the SKILL.md frontmatter, reports any risky tools it declares, and
// only copies it into ~/.cynco/skills after the caller confirms.

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { validateFrontmatter, RISKY_TOOLS } from './types.js'
import { assertInside, workspaceSkillsDir } from './loader.js'

const execFileAsync = promisify(execFile)

export type InstallSpec = { owner: string; repo: string; ref?: string; subdir?: string }

export type InstallResult = { installed: boolean; name: string; dir?: string }

export type InstallOptions = {
  workspaceDir?: string
  knownTools: ReadonlySet<string>
  /** Show the report, return true to proceed with the copy. */
  confirm: (report: string) => Promise<boolean>
  /** Fetch + extract the zipball, returning the extraction root. Injectable for tests. */
  fetchAndExtract?: (spec: InstallSpec) => Promise<string>
}

/** Parse `owner/repo[/subdir...][@ref]` into its parts. Throws on malformed input. */
export function parseInstallSpec(spec: string): InstallSpec {
  let ref: string | undefined
  let rest = spec.trim()
  const at = rest.indexOf('@')
  if (at !== -1) {
    ref = rest.slice(at + 1) || undefined
    rest = rest.slice(0, at)
  }
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error(`install spec must be owner/repo[/subdir][@ref] (got ${JSON.stringify(spec)})`)
  const [owner, repo, ...subParts] = parts
  return { owner, repo, ref, subdir: subParts.length ? subParts.join('/') : undefined }
}

/**
 * Extract a .zip to destDir. Windows: PowerShell Expand-Archive; else `unzip`.
 *
 * The paths travel in the environment rather than in the command text. The
 * previous form interpolated them into a single-quoted PowerShell literal, so a
 * quote anywhere in either path ended the literal and handed the remainder to
 * the parser. Both paths are mkdtemp-derived today, which made it latent rather
 * than live — and latent is exactly the kind of thing that stops being latent
 * when someone later passes a user-chosen destination.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; " +
      'Expand-Archive -LiteralPath $env:CYNCO_ZIP_SRC -DestinationPath $env:CYNCO_ZIP_DEST -Force',
    ], {
      timeout: 60000,
      env: { ...process.env, CYNCO_ZIP_SRC: zipPath, CYNCO_ZIP_DEST: destDir },
    })
  } else {
    await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 60000 })
  }
}

/** Default fetch+extract: GitHub codeload zipball → temp dir. */
async function defaultFetchAndExtract(spec: InstallSpec): Promise<string> {
  const ref = spec.ref ?? 'HEAD'
  const url = `https://codeload.github.com/${spec.owner}/${spec.repo}/zip/${ref}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'CynCo/1.0' },
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new Error(`GitHub zipball fetch failed: ${resp.status} ${resp.statusText}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-skill-dl-'))
  const zipPath = path.join(tmp, 'skill.zip')
  fs.writeFileSync(zipPath, buf)
  const extractDir = path.join(tmp, 'extract')
  await extractZip(zipPath, extractDir)
  return extractDir
}

/** Descend into the single top-level dir GitHub nests everything under. */
function repoRoot(extractRoot: string): string {
  if (fs.existsSync(path.join(extractRoot, 'SKILL.md'))) return extractRoot
  const dirs = fs.readdirSync(extractRoot, { withFileTypes: true }).filter(e => e.isDirectory())
  return dirs.length === 1 ? path.join(extractRoot, dirs[0].name) : extractRoot
}

/** Recursively collect directories that directly contain a SKILL.md. */
function findSkillDirs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) out.push(dir)
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name))
  }
  walk(root)
  return out
}

/** Locate the one skill folder to install, honoring an explicit subdir. */
function resolveSkillDir(extractRoot: string, subdir?: string): string {
  const root = repoRoot(extractRoot)
  // `path.join` here, with a subdir built by splitting the spec on '/', made
  // `owner/repo/../../..` an ordinary path — and whatever it found got cpSync'd
  // into ~/.cynco/skills. Locally supplied, so lower severity than /skill
  // remove, but the same class of gap and the same fix.
  const base = subdir ? assertInside(root, subdir) : root
  if (fs.existsSync(path.join(base, 'SKILL.md'))) return base
  const found = findSkillDirs(base)
  if (found.length === 1) return found[0]
  if (found.length === 0) throw new Error('no SKILL.md found in the repository')
  throw new Error(`multiple skills found — pass a subdir to pick one:\n${found.map(d => path.relative(root, d)).join('\n')}`)
}

/**
 * Split a SKILL.md into its frontmatter block and its prose body.
 *
 * The body is returned, not discarded, because the body is what the model is
 * handed as instructions — and a confirmation that omits it is asking about
 * something other than what it installs.
 */
function splitSkillMd(text: string): { frontmatter: string; body: string } {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!t.startsWith('---')) throw new Error('SKILL.md: missing frontmatter fence')
  const end = t.indexOf('\n---', 3)
  const firstNewline = t.indexOf('\n')
  if (end === -1 || firstNewline === -1 || firstNewline >= end) throw new Error('SKILL.md: malformed frontmatter fence')
  const afterFence = t.indexOf('\n', end + 1)
  return {
    frontmatter: t.slice(firstNewline + 1, end),
    body: afterFence === -1 ? '' : t.slice(afterFence + 1),
  }
}

function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') return (Bun as any).YAML.parse(input)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}

/** How much of an untrusted skill body the confirmation quotes verbatim. */
export const BODY_PREVIEW_LINES = 40

/**
 * The text the user is asked to approve.
 *
 * Two ordering decisions, both deliberate:
 *
 *  - The risky-tool warning comes BEFORE the description. The description is a
 *    line the repository author wrote and can aim at the warning ("the Bash
 *    below is only for the test runner"); a warning that trails the prose
 *    arguing against it is arguing second.
 *  - The body is quoted, capped, and labelled as what the model will be told to
 *    do. Name and description are metadata; the body is the payload, and it was
 *    the one part the previous report never showed.
 */
function buildReport(name: string, description: string, tools: string[], body: string, source: string): string {
  const risky = tools.filter(t => RISKY_TOOLS.has(t))
  const lines = [`Install skill "${name}" from ${source}?`]
  if (risky.length) lines.push(`  ⚠ Risky tools (filesystem/shell/network): ${risky.join(', ')}`)
  lines.push(tools.length ? `  Tools: ${tools.join(', ')}` : '  Tools: (none)')
  lines.push(`  ${description}`)

  const bodyLines = body.replace(/\n+$/, '').split('\n')
  const total = bodyLines.length
  const shown = bodyLines.slice(0, BODY_PREVIEW_LINES)
  lines.push('', '  The body below is given to the model as instructions:', '  ---')
  for (const l of shown) lines.push(`  | ${l}`)
  lines.push('  ---')
  if (total > shown.length) {
    lines.push(`  (showing ${shown.length} of ${total} lines — ${total - shown.length} more lines not shown; the model receives all of them)`)
  }
  return lines.join('\n')
}

/**
 * Fetch, validate, confirm, and install a skill into the workspace skills dir.
 * Validation errors reject; a declined confirmation returns installed:false.
 */
export async function installSkill(spec: string, opts: InstallOptions): Promise<InstallResult> {
  const parsed = parseInstallSpec(spec)
  const fetchAndExtract = opts.fetchAndExtract ?? defaultFetchAndExtract
  const extractRoot = await fetchAndExtract(parsed)

  const skillDir = resolveSkillDir(extractRoot, parsed.subdir)
  const { frontmatter, body } = splitSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'))
  const fm = validateFrontmatter(parseYaml(frontmatter), opts.knownTools)

  const source = `${parsed.owner}/${parsed.repo}${parsed.ref ? `@${parsed.ref}` : ''}`
  const approved = await opts.confirm(buildReport(fm.name, fm.description, fm.tools, body, source))
  if (!approved) return { installed: false, name: fm.name }

  const workspaceDir = opts.workspaceDir ?? workspaceSkillsDir()
  const dest = path.join(workspaceDir, fm.name)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.cpSync(skillDir, dest, { recursive: true })
  return { installed: true, name: fm.name, dir: dest }
}
