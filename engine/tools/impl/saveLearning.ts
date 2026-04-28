/**
 * SaveLearning tool — the model can save user preferences, corrections,
 * and feedback as persistent learnings, as persistent learnings.
 *
 * Saves to ~/.cynco/continuity/{projectHash}/learnings.json
 */
import type { ToolImpl } from '../types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

function getLearningsPath(): string {
  const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
  return path.join(os.homedir(), '.cynco', 'continuity', projectHash, 'learnings.json')
}

export const saveLearningTool: ToolImpl = {
  name: 'SaveLearning',
  description: 'Save a user preference, correction, or feedback as a persistent learning. Use this when the user corrects your approach, expresses a preference, or gives feedback about how they want things done. These learnings persist across sessions. The user can review all saved learnings with /learnings.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Type of learning: "preference" (user likes/dislikes), "correction" (user fixed something), "pattern" (recurring codebase pattern), "decision" (architectural choice made)',
      },
      content: {
        type: 'string',
        description: 'The learning itself — what to remember. Be specific and actionable.',
      },
      context: {
        type: 'string',
        description: 'Optional context about when this applies.',
      },
    },
    required: ['type', 'content'],
  },
  tier: 'auto',
  execute: async (input) => {
    const type = (input.type as string) || 'preference'
    const content = (input.content as string) || ''
    const context = (input.context as string) || ''

    if (!content) {
      return { output: 'No content provided', isError: true }
    }

    try {
      const filePath = getLearningsPath()
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      let learnings: any[] = []
      if (fs.existsSync(filePath)) {
        learnings = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }

      // Don't save duplicates
      const isDuplicate = learnings.some(
        (l: any) => l.content === content && l.type === type
      )
      if (isDuplicate) {
        return { output: `Learning already saved: ${content.slice(0, 60)}`, isError: false }
      }

      learnings.push({
        type,
        content,
        context,
        date: new Date().toISOString(),
      })

      // Keep last 100 learnings
      if (learnings.length > 100) {
        learnings = learnings.slice(-100)
      }

      fs.writeFileSync(filePath, JSON.stringify(learnings, null, 2))
      return {
        output: `Saved learning: ${content.slice(0, 60)}...`,
        isError: false,
      }
    } catch (err) {
      return {
        output: `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
