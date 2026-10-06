/**
 * Inventory of every LOCALCODE_* environment variable the engine reads, with the
 * default each read site falls back to, derived from the source.
 *
 * This exists because the README's configuration table was written by hand and
 * drifted: it named `ollama` as the default provider while `config.ts` coalesced
 * to `llama-cpp`, called `LOCALCODE_MODEL` "required" when it has not been
 * required since the profile loader landed, and listed 23 of the 62 variables
 * the engine actually reads. A hand-maintained list of a machine-checkable fact
 * decays silently; this reads the fact.
 *
 * Used by `configTableMatchesTheCode.test.ts` and by
 * `scripts/generate-env-docs.mjs`, which writes the table into README.md.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
export const engineRoot = join(here, '..', '..')
export const repoRoot = join(here, '..', '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Tests set env vars to exercise branches; a name that appears only under
    // __tests__ is not a knob a user can turn, and documenting it would be a
    // lie in the other direction.
    if (name === 'node_modules' || name === '__tests__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/**
 * What a single read site falls back to when the variable is unset.
 *
 * Returns `{ def, profileKey }`. Either may be null, and null means "this
 * scanner could not read a fallback out of the expression", never "there is no
 * fallback" — the two are different and the rendered table says which it is.
 *
 * `profileKey` matters more than it looks: the README claimed "No config files
 * required" while `config.ts` layers a YAML profile between the environment and
 * the built-in default for most of these. A column naming that key is the
 * shortest correction of that claim.
 */
function deriveDefault(text, at, name, readPrefix = 'process\\.env\\.') {
  const tail = text.slice(at, at + 220)
  const read = `${readPrefix}${name}`
  const LIT = `('([^']*)'|"([^"]*)"|\`([^\`]*)\`|-?\\d+(?:\\.\\d+)?)`
  const lit = m => {
    const v = m[2] ?? m[3] ?? m[4] ?? m[1]
    return v === 'undefined' || v === '' ? null : v
  }

  // (process.env.X ?? 'true') !== 'false'  — an opt-OUT flag, on unless disabled
  const wrapped = tail.match(new RegExp(`^\\(?${read}\\s*(?:\\?\\?|\\|\\|)\\s*'(true|false)'\\)?\\s*!==\\s*'(true|false)'`))
  if (wrapped) return { def: String(wrapped[1] !== wrapped[2]), profileKey: null }

  // Bare comparisons. `X !== 'false'` and `X !== '0'` are on-unless-disabled;
  // `X === 'true'` is off-unless-enabled. The sentinel is the disabling value,
  // so the default is its negation.
  if (new RegExp(`^${read}\\s*!==\\s*'(?:false|0)'`).test(tail)) return { def: 'true', profileKey: null }
  if (new RegExp(`^${read}\\s*===\\s*'(?:false|0)'`).test(tail)) return { def: 'true', profileKey: null }
  if (new RegExp(`^${read}\\s*!==\\s*'(?:true|1)'`).test(tail)) return { def: 'false', profileKey: null }
  if (new RegExp(`^${read}\\s*===\\s*'(?:true|1)'`).test(tail)) return { def: 'false', profileKey: null }

  // process.env.X ?? profile?.key ?? 'literal'
  const viaProfile = tail.match(new RegExp(`^${read}\\s*\\?\\?\\s*profile\\?\\.([a-z_]+)(?:\\s*\\?\\?\\s*${LIT})?`))
  if (viaProfile) {
    return { def: viaProfile[2] ? lit(viaProfile.slice(1)) : null, profileKey: viaProfile[1] }
  }

  // hasEnvVar('X') ? process.env.X! : profile?.key ?? 'literal'
  //
  // The read itself carries no fallback here — it is the true branch of a
  // ternary whose false branch is the whole resolution chain. Matching only the
  // read would report these five variables as having no default at all, which
  // is exactly the wrong answer for LOCALCODE_MODEL.
  const ternary = tail.match(new RegExp(`^${read}!(?:\\s*,\\s*10)?\\)?\\s*\\n?\\s*:\\s*profile\\?\\.([a-z_]+)(?:\\s*\\?\\?\\s*${LIT})?`))
  if (ternary) {
    return { def: ternary[2] ? lit(ternary.slice(1)) : null, profileKey: ternary[1] }
  }

  // process.env.X ?? 'literal'   /  || "literal"  /  ?? 42  /  ?? undefined
  const coalesce = tail.match(new RegExp(`^${read}\\s*(?:\\?\\?|\\|\\|)\\s*${LIT}`))
  if (coalesce) return { def: lit(coalesce), profileKey: null }

  // The read lands in a const first and the fallback is a guard on that const:
  //
  //   const v = env.X                       const n = Number(env.X)
  //   return v && v.trim() ? v : FALLBACK   if (!Number.isFinite(n) || n <= 0) return FALLBACK
  //
  // FALLBACK is a literal, or `join(homedir(), 'a', ...)`, rendered `~/a/...`.
  const bound = text.slice(Math.max(0, at - 60), at).match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Number\()?$/)
  if (bound) {
    const v = bound[1].replace(/\$/g, '\\$')
    const FALLBACK = `(?:${LIT}|join\\(\\s*homedir\\(\\)\\s*,\\s*((?:'[^']*'\\s*,?\\s*)+)\\))`
    const fallback = m => {
      if (m[5] != null) return '~/' + [...m[5].matchAll(/'([^']*)'/g)].map(x => x[1]).join('/')
      return lit(m)
    }
    const truthy = tail.match(new RegExp(`^${read}\\)?\\s*\\n\\s*return\\s+${v}\\s*&&\\s*${v}\\.trim\\(\\)\\s*\\?\\s*${v}(?:\\.trim\\(\\))?\\s*:\\s*${FALLBACK}`))
    if (truthy) return { def: fallback(truthy), profileKey: null }
    const guard = tail.match(new RegExp(`^${read}\\)?\\s*\\n\\s*if\\s*\\([^\\n]*\\b${v}\\b[^\\n]*\\)\\s*return\\s+${FALLBACK}`))
    if (guard) return { def: fallback(guard), profileKey: null }
  }

  return { def: null, profileKey: null }
}

/**
 * Byte ranges of every function whose `env` parameter defaults to
 * `process.env` — `function f(env: NodeJS.ProcessEnv = process.env)`, or a
 * destructured `{ env = process.env }` — from its parameter list to the end of
 * its body. Inside one, `env.LOCALCODE_X` is a read of the process
 * environment exactly as `process.env.LOCALCODE_X` is: the parameter exists
 * only so a test can inject a fake, and with no argument it IS process.env.
 * Projects mode reads all three of its knobs this way; a scanner blind to the
 * shape listed none of them.
 *
 * Bracket matching skips string and template literals but not regex literals
 * or comments — enough for a parameter list and a function body, which is all
 * it is asked to find. A range it cannot close runs to the end of the file.
 */
export function injectedEnvScopes(text) {
  const closer = { '(': ')', '[': ']', '{': '}' }
  // From `open` (an opening bracket), the index of its matching closer, or -1.
  const matchForward = open => {
    const stack = []
    for (let i = open; i < text.length; i++) {
      const c = text[i]
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
        continue
      }
      if (closer[c]) stack.push(closer[c])
      else if (c === ')' || c === ']' || c === '}') {
        if (stack.pop() !== c) return -1
        if (stack.length === 0) return i
      }
    }
    return -1
  }
  // The `(` of the parameter list that holds `at`: the nearest unmatched one before it.
  const openParenBefore = at => {
    let depth = 0
    for (let i = at - 1; i >= 0; i--) {
      const c = text[i]
      if (c === ')') depth++
      else if (c === '(') { if (depth === 0) return i; depth-- }
    }
    return -1
  }
  const scopes = []
  for (const m of text.matchAll(/(?<![.\w$])env\s*(?::[^=)]+?)?=\s*process\.env\b(?!\s*\.)/g)) {
    const open = openParenBefore(m.index)
    if (open === -1) continue
    const close = matchForward(open)
    if (close === -1) { scopes.push([open, text.length]); continue }
    // A return type, then the body: `{ ... }`, or an arrow's expression to end of line.
    const head = text.slice(close + 1).match(/^\s*(?::[^{;=]*)?\s*(=>)?\s*(\{)?/)
    let end = close
    if (head[2]) {
      const body = close + head[0].length
      const shut = matchForward(body)
      end = shut === -1 ? text.length : shut
    } else if (head[1]) {
      const nl = text.indexOf('\n', close + head[0].length + 1)
      end = nl === -1 ? text.length : nl
    }
    scopes.push([open, end])
  }
  return scopes
}

/**
 * The same, for names reached through a helper rather than a direct index:
 * `envInt('LOCALCODE_UBATCH_SIZE') ?? 2048`.
 *
 * Three llama-server knobs are read only this way, and all three were in the
 * README's hand-written table — so a scanner that looked for `process.env.` and
 * nothing else would have reported them as documented-but-nonexistent and
 * failed the guard on its own blind spot.
 */
function deriveHelperDefault(text, at, name) {
  const tail = text.slice(at, at + 220)
  const LIT = `('([^']*)'|"([^"]*)"|\`([^\`]*)\`|-?\\d+(?:\\.\\d+)?)`
  const m = tail.match(new RegExp(`^'${name}'\\s*\\)\\s*(?:\\?\\?|\\|\\|)\\s*${LIT}`))
  if (!m) return { def: null, profileKey: null }
  const v = m[2] ?? m[3] ?? m[4] ?? m[1]
  return { def: v === 'undefined' || v === '' ? null : v, profileKey: null }
}

/**
 * Every LOCALCODE_* name the engine reads outside its tests.
 *
 * Shape: { NAME: { defaults: string[], profileKeys: string[], files: string[] } }.
 * `defaults` is the set of distinct fallbacks across all read sites — more than
 * one entry means two call sites disagree about the default, which is worth
 * seeing rather than collapsing.
 */
export function scanEnvVars() {
  const found = {}
  for (const file of walk(engineRoot)) {
    const text = readFileSync(file, 'utf-8')
    const rel = relative(repoRoot, file).replace(/\\/g, '/')
    const record = (name, { def, profileKey }) => {
      const entry = (found[name] ??= { defaults: [], profileKeys: [], files: [] })
      if (!entry.files.includes(rel)) entry.files.push(rel)
      if (def != null && !entry.defaults.includes(def)) entry.defaults.push(def)
      if (profileKey != null && !entry.profileKeys.includes(profileKey)) entry.profileKeys.push(profileKey)
    }
    for (const m of text.matchAll(/(process\.env\.|')(LOCALCODE_[A-Z0-9_]+)/g)) {
      const name = m[2]
      const quoted = m[1] === "'"
      record(name, quoted ? deriveHelperDefault(text, m.index, name) : deriveDefault(text, m.index, name))
    }
    // `env.LOCALCODE_X` where `env` is a parameter defaulting to process.env.
    const seen = new Set()
    for (const [from, to] of injectedEnvScopes(text)) {
      const scope = text.slice(from, to)
      for (const m of scope.matchAll(/(?<![.\w$])env\.(LOCALCODE_[A-Z0-9_]+)/g)) {
        const at = from + m.index
        if (seen.has(at)) continue // nested scopes see the same read twice
        seen.add(at)
        record(m[1], deriveDefault(text, at, m[1], 'env\\.'))
      }
    }
  }
  for (const entry of Object.values(found)) {
    entry.defaults.sort()
    entry.profileKeys.sort()
    entry.files.sort()
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)))
}

export const BEGIN = '<!-- BEGIN GENERATED ENV INVENTORY -->'
export const END = '<!-- END GENERATED ENV INVENTORY -->'

/** The markdown between the markers, generated from the scan. */
export function renderInventory(vars = scanEnvVars()) {
  const rows = Object.entries(vars).map(([name, { defaults, profileKeys, files }]) => {
    // Never invent a default. A blank fallback is reported as "not derived",
    // which is a statement about the scanner, not about the code — the whole
    // finding this file answers is a table that stated a default it had not
    // checked.
    const def = defaults.length === 0 ? '*not derived*' : defaults.map(d => `\`${d}\``).join(' / ')
    const key = profileKeys.length === 0 ? '—' : profileKeys.map(k => `\`${k}\``).join(', ')
    return `| \`${name}\` | ${def} | ${key} | ${files.map(f => `\`${f}\``).join(', ')} |`
  })
  return [
    BEGIN,
    '',
    '<!-- Generated by scripts/generate-env-docs.mjs. Do not edit by hand.',
    '     Regenerate with: bun scripts/generate-env-docs.mjs -->',
    '',
    `Every \`LOCALCODE_*\` variable the engine reads — ${rows.length} of them — with the fallback`,
    'each read site uses when it is unset, and the profile key (if any) that sits between the',
    'two. Read out of the source by `scripts/generate-env-docs.mjs`, so it cannot drift from',
    'the code the way a hand-written list does.',
    '',
    '`*not derived*` is a statement about the generator, not about the engine: the read site',
    'resolves in a shape the scanner does not recognise, so no default is claimed for it. Two',
    'values separated by `/` mean two read sites disagree.',
    '',
    '| Variable | Default when unset | Profile key | Read in |',
    '|----------|--------------------|-------------|---------|',
    ...rows,
    '',
    END,
  ].join('\n')
}

/** The current README block, or null when the markers are missing. */
export function readmeInventory() {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8').split('\r\n').join('\n')
  const start = readme.indexOf(BEGIN)
  const end = readme.indexOf(END)
  if (start === -1 || end === -1) return null
  return readme.slice(start, end + END.length)
}
