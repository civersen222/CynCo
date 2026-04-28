import type { ToolImpl } from '../types.js'

export const notebookEditTool: ToolImpl = {
  name: 'NotebookEdit',
  description: 'Edit a Jupyter notebook cell. Specify the cell index and new content.',
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path to the .ipynb file' },
      cell_index: { type: 'number', description: 'Zero-based index of the cell to edit' },
      new_source: { type: 'string', description: 'New source content for the cell' },
      cell_type: { type: 'string', description: 'Cell type: code or markdown (default: unchanged)' },
    },
    required: ['notebook_path', 'cell_index', 'new_source'],
  },
  tier: 'approval',
  execute: async (input, cwd) => {
    const { resolve } = await import('path')
    const { readFileSync, writeFileSync, existsSync } = await import('fs')
    const nbPath = resolve(cwd, input.notebook_path as string)
    if (!existsSync(nbPath)) return { output: `Error: notebook not found: ${nbPath}`, isError: true }
    try {
      const nb = JSON.parse(readFileSync(nbPath, 'utf-8'))
      const idx = input.cell_index as number
      if (idx < 0 || idx >= nb.cells.length) return { output: `Error: cell index ${idx} out of range (0-${nb.cells.length - 1})`, isError: true }
      const newSource = input.new_source as string
      nb.cells[idx].source = newSource.split('\n').map((l: string, i: number, arr: string[]) => i < arr.length - 1 ? l + '\n' : l)
      if (input.cell_type) nb.cells[idx].cell_type = input.cell_type
      writeFileSync(nbPath, JSON.stringify(nb, null, 1) + '\n')
      return { output: `Edited cell ${idx} in ${nbPath}`, isError: false }
    } catch (err) {
      return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
