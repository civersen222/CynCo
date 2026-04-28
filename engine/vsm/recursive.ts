/**
 * RecursiveVSM — a Viable System Model tree for hierarchical agent management.
 *
 * Models a recursive decomposition of agents across VSM levels.
 * Enforces a maximum depth to prevent unbounded recursion.
 */

// ─── Types ────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed'

export type VSMLevel = {
  name: string
  level: number
  tools: string[]
  status: AgentStatus
  children: VSMLevel[]
}

// ─── Status Icons ─────────────────────────────────────────────────

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
}

// ─── RecursiveVSM ─────────────────────────────────────────────────

export class RecursiveVSM {
  readonly root: VSMLevel
  private maxDepth: number

  constructor(name: string, maxDepth = 3) {
    this.maxDepth = maxDepth
    this.root = {
      name,
      level: 0,
      tools: [],
      status: 'idle',
      children: [],
    }
  }

  /** Add a top-level agent (at level 1, child of root). */
  addAgent(name: string, tools: string[]): void {
    this.root.children.push({
      name,
      level: 1,
      tools: [...tools],
      status: 'idle',
      children: [],
    })
  }

  /**
   * Add a sub-agent under an existing named agent.
   *
   * @throws Error if the resulting level would exceed maxDepth
   */
  addSubAgent(parentName: string, name: string, tools: string[]): void {
    const parent = this.getAgent(parentName)
    if (!parent) {
      throw new Error(`Parent agent "${parentName}" not found`)
    }

    const newLevel = parent.level + 1
    if (newLevel >= this.maxDepth) {
      throw new Error(
        `Cannot add sub-agent "${name}" at level ${newLevel} — exceeds maxDepth of ${this.maxDepth}`,
      )
    }

    parent.children.push({
      name,
      level: newLevel,
      tools: [...tools],
      status: 'idle',
      children: [],
    })
  }

  /** Find an agent anywhere in the tree by name. */
  getAgent(name: string): VSMLevel | undefined {
    return findAgent(this.root, name)
  }

  /** Set the status of a named agent. */
  setAgentStatus(name: string, status: AgentStatus): void {
    const agent = this.getAgent(name)
    if (agent) {
      agent.status = status
    }
  }

  /** Return a tree-view string with status icons and levels. */
  getSummary(): string {
    const lines: string[] = []
    renderNode(this.root, '', true, lines)
    return lines.join('\n')
  }

  /** Total number of nodes in the tree (excluding root). */
  get agentCount(): number {
    return countAgents(this.root) - 1 // subtract root itself
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function findAgent(node: VSMLevel, name: string): VSMLevel | undefined {
  if (node.name === name) return node
  for (const child of node.children) {
    const found = findAgent(child, name)
    if (found) return found
  }
  return undefined
}

function countAgents(node: VSMLevel): number {
  return 1 + node.children.reduce((sum, child) => sum + countAgents(child), 0)
}

function renderNode(
  node: VSMLevel,
  indent: string,
  isLast: boolean,
  lines: string[],
): void {
  const icon = STATUS_ICON[node.status]
  const connector = indent === '' ? '' : isLast ? '└── ' : '├── '
  const toolStr = node.tools.length > 0 ? ` [${node.tools.join(', ')}]` : ''
  lines.push(`${indent}${connector}${icon} ${node.name} (L${node.level})${toolStr}`)

  const childIndent = indent + (indent === '' ? '' : isLast ? '    ' : '│   ')
  for (let i = 0; i < node.children.length; i++) {
    renderNode(node.children[i]!, childIndent, i === node.children.length - 1, lines)
  }
}
