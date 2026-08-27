import { createHash } from 'crypto'
import { createRequire } from 'module'
import type { Chunk } from '../index/types.js'

// Extended chunk with optional relationship and signature fields
export type ChunkRelationship = { targetFile: string; relType: 'imports' }

export type ASTChunk = Chunk & {
  relationships?: ChunkRelationship[]
  signature?: string
}

/**
 * Bump when chunk emission changes shape. An already-indexed file's content
 * hash is unchanged, so without a version bump the hash-compare in
 * refreshFromGitStatus would never re-chunk it and old chunk sets (missing
 * class methods / module constants, 2026-08-27 eval) would live forever.
 * v2: class-body methods and module-level assignments get named chunks.
 */
export const CHUNKER_VERSION = '2'

// ─── Language Mapping ─────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
}

// ─── Singleton State ──────────────────────────────────────────────────────────

let parserInitialized = false
let initPromise: Promise<void> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LanguageClass: any = null

// Cache: lang name → loaded Language object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>()

// ─── Init ─────────────────────────────────────────────────────────────────────

async function ensureInitialized(): Promise<void> {
  if (parserInitialized) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    // web-tree-sitter is an ES module — use dynamic import
    const webTreeSitter = await import('web-tree-sitter')
    ParserClass = webTreeSitter.Parser
    LanguageClass = webTreeSitter.Language

    // Locate the web-tree-sitter WASM runtime file. Resolve the wasm subpath
    // directly — it's an explicit `exports` entry — rather than resolving
    // `package.json`, whose subpath Node's strict exports enforcement blocks.
    const _require = createRequire(import.meta.url)
    const wasmRuntimePath = _require.resolve('web-tree-sitter/web-tree-sitter.wasm')

    await ParserClass.init({
      locateFile: () => wasmRuntimePath,
    })

    parserInitialized = true
  })()

  return initPromise
}

// ─── Language Loader ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadLanguage(langName: string): Promise<any> {
  if (languageCache.has(langName)) return languageCache.get(langName)

  // Resolve via the package's `./*` → `./out/*` exports mapping instead of
  // `package.json` (blocked by Node's strict exports enforcement under vitest).
  const _require = createRequire(import.meta.url)
  const wasmPath = _require.resolve(`tree-sitter-wasm/${langName}/tree-sitter-${langName}.wasm`)

  const lang = await LanguageClass.load(wasmPath)
  languageCache.set(langName, lang)
  return lang
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function extractImportTarget(node: /* Node */ { type: string; text: string; children: unknown[]; childForFieldName: (name: string) => { text: string } | null }): string | null {
  // Look for a string child that contains the import source
  const source = node.childForFieldName('source') ?? node.childForFieldName('module')
  if (source) {
    return source.text.replace(/^['"`]|['"`]$/g, '')
  }
  // Fallback: scan text for quoted string
  const m = node.text.match(/from\s+['"`]([^'"`]+)['"`]/)
  if (m) return m[1]
  return null
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Parse a source file with tree-sitter and return AST-based chunks.
 * Returns null for unsupported file extensions (caller should use regex fallback).
 */
export async function treeSitterChunk(filePath: string, content: string): Promise<ASTChunk[] | null> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const langName = EXT_TO_LANG[ext]
  if (!langName) return null

  await ensureInitialized()

  let lang: unknown
  try {
    lang = await loadLanguage(langName)
  } catch {
    // Grammar not available — fall back
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new ParserClass() as any
  parser.setLanguage(lang)

  const tree = parser.parse(content)
  if (!tree) return null

  const lines = content.split('\n')
  const hash = fileHash(content)
  const chunks: ASTChunk[] = []
  const importNodes: unknown[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const push = (node: any, chunkType: 'function' | 'class' | 'module', name: string | null): void => {
    const startLine = (node.startPosition.row as number) + 1
    const rawEnd = (node.endPosition.row as number) + 1
    const endLine = Math.min(rawEnd, startLine + 79)
    chunks.push({
      filePath, chunkType, name,
      startLine, endLine,
      content: lines.slice(startLine - 1, endLine).join('\n'),
      fileHash: hash,
      signature: name ?? undefined,
    })
  }

  // Class methods past the class chunk's 80-line cap existed in NO chunk
  // (wed_match, marriages.py:209 — 2026-08-27 eval), so each def in a class
  // body gets its own named function chunk regardless of the cap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pushClassMethods = (classNode: any): void => {
    const body = classNode.childForFieldName?.('body')
    if (!body) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const member of (body.children as any[])) {
      const def = member.type === 'decorated_definition'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (member.children as any[]).find((c: any) => c.type === 'function_definition')
        : member
      if (!def) continue
      if (def.type === 'function_definition' || def.type === 'method_definition') {
        push(member, 'function', def.childForFieldName?.('name')?.text ?? null)
      }
    }
  }

  // Walk top-level children of the root
  const root = tree.rootNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (let node of (root.children as any[])) {
    // Python decorated defs wrap the real definition; keep the decorator lines
    // by chunking from the wrapper but classifying/naming from the inner def.
    const wrapper = node
    if (node.type === 'decorated_definition') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (node.children as any[]).find((c: any) =>
        c.type === 'function_definition' || c.type === 'class_definition')
      if (inner) node = inner
    }
    const type: string = node.type

    // Collect import nodes to merge into a single import_block later
    if (
      type === 'import_statement' ||         // TS/JS
      type === 'import_declaration' ||       // some grammars
      type === 'import_from_statement' ||    // Python
      type === 'import_statement_as' ||      // Python variants
      (langName === 'python' && (type === 'import_statement' || type === 'import_from_statement'))
    ) {
      importNodes.push(node)
      continue
    }

    // Function declarations
    if (
      type === 'function_declaration' ||
      type === 'function_definition' ||      // Python
      type === 'method_definition'
    ) {
      push(wrapper, 'function', node.childForFieldName?.('name')?.text ?? null)
      continue
    }

    // Class declarations
    if (
      type === 'class_declaration' ||
      type === 'class_definition'   // Python
    ) {
      push(wrapper, 'class', node.childForFieldName?.('name')?.text ?? null)
      pushClassMethods(node)
      continue
    }

    // Module-level assignments: TREASURY_LABELS/ACCEPT_SCORE-style constants
    // had no chunk at all (2026-08-27 eval misses), so findByName never fired.
    if (langName === 'python' && type === 'expression_statement') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assign = (node.children as any[]).find((c: any) => c.type === 'assignment')
      const left = assign?.childForFieldName?.('left')
      if (left?.type === 'identifier') push(node, 'module', left.text)
      continue
    }
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const declName = (node.children as any[])
        .find((c: any) => c.type === 'variable_declarator')?.childForFieldName?.('name')?.text
      if (declName) push(node, 'module', declName)
      continue
    }

    // Export statements — unwrap to find inner function/class
    if (
      type === 'export_statement' ||
      type === 'export_declaration'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (node.children as any[]).find((c: any) =>
        c.type === 'function_declaration' ||
        c.type === 'class_declaration' ||
        c.type === 'async_function_declaration' ||
        c.type === 'lexical_declaration'
      )
      if (inner) {
        const isClass = inner.type === 'class_declaration'
        const nameNode = inner.childForFieldName?.('name') ??
          // lexical_declaration: grab first variable_declarator name
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (inner.children as any[]).find((c: any) => c.type === 'variable_declarator')?.childForFieldName?.('name')
        push(node, isClass ? 'class' : 'function', nameNode?.text ?? null)
        if (isClass) pushClassMethods(inner)
      }
    }
  }

  // Build import_block from collected import nodes
  if (importNodes.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstNode = importNodes[0] as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastNode = importNodes[importNodes.length - 1] as any
    const startLine = (firstNode.startPosition.row as number) + 1
    const rawEnd = (lastNode.endPosition.row as number) + 1
    const endLine = Math.min(rawEnd, startLine + 79)
    const chunkContent = lines.slice(startLine - 1, endLine).join('\n')

    // Extract relationships
    const relationships: ChunkRelationship[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const inode of importNodes as any[]) {
      const target = extractImportTarget(inode)
      if (target) relationships.push({ targetFile: target, relType: 'imports' })
    }

    chunks.unshift({
      filePath, chunkType: 'import_block', name: null,
      startLine, endLine,
      content: chunkContent,
      fileHash: hash,
      relationships,
    })
  }

  return chunks
}
