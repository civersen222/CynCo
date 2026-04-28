import type { ToolImpl, ApprovalTier } from './types.js'
import type { ToolDefinition } from '../types.js'
import { readTool } from './impl/read.js'
import { writeTool } from './impl/write.js'
import { editTool } from './impl/edit.js'
import { bashTool } from './impl/bash.js'
import { globTool } from './impl/glob.js'
import { grepTool } from './impl/grep.js'
import { gitTool } from './impl/git.js'
import { webFetchTool } from './impl/webFetch.js'
import { imageViewTool } from './impl/imageView.js'
import { notebookEditTool } from './impl/notebookEdit.js'
import { multiEditTool } from './impl/multiEdit.js'
import { applyPatchTool } from './impl/applyPatch.js'
import { lsTool } from './impl/ls.js'
import { codeSearchTool } from './impl/codeSearch.js'
import { webSearchTool } from './impl/webSearch.js'
import { saveLearningTool } from './impl/saveLearning.js'
import { codeIndexTool } from './impl/codeIndex.js'

export const ALL_TOOLS: ToolImpl[] = [
  readTool, globTool, grepTool, editTool, writeTool,
  bashTool, gitTool, webFetchTool, webSearchTool, imageViewTool, notebookEditTool,
  multiEditTool, applyPatchTool, lsTool, codeSearchTool, codeIndexTool, saveLearningTool,
]

export function getToolsByTier(tier: ApprovalTier): ToolImpl[] {
  return ALL_TOOLS.filter(t => t.tier === tier)
}

export function getToolByName(name: string): ToolImpl | undefined {
  return ALL_TOOLS.find(t => t.name === name)
}

export function getToolDefinitions(tools?: ToolImpl[]): ToolDefinition[] {
  return (tools ?? ALL_TOOLS).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}
