import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ToolImpl } from '../types.js'
import { uncontainedSiteRefusal } from '../../containment.js'

export const applyPatchTool: ToolImpl = {
  name: 'ApplyPatch',
  description: 'Apply a unified diff patch to files in the repository using git apply. The patch must be in standard unified diff format.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The unified diff patch to apply' },
      check: { type: 'boolean', description: 'Only check if patch applies cleanly without actually applying it. Default: false.' },
    },
    required: ['patch'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    // F242: `git apply` here would run at medium integrity in the mission folder; refused in a
    // contained run until this site is contained.
    const uncontained = uncontainedSiteRefusal('ApplyPatch')
    if (uncontained) return { output: uncontained, isError: true }
    const patch = input.patch as string
    const checkOnly = (input.check as boolean) ?? false

    // Write patch to a temp file
    const patchFile = join(tmpdir(), `lc-patch-${randomUUID()}.patch`)
    try {
      writeFileSync(patchFile, patch, 'utf-8')
      const flags = checkOnly ? '--check' : ''
      const stdout = execSync(`git apply ${flags} "${patchFile}" 2>&1`, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const msg = checkOnly ? 'Patch applies cleanly.' : 'Patch applied successfully.'
      return { output: stdout || msg, isError: false }
    } catch (err: any) {
      const output = err.stdout ?? err.stderr ?? err.message ?? 'Unknown error'
      return { output: `Patch failed: ${output}`, isError: true }
    } finally {
      try { require('fs').unlinkSync(patchFile) } catch {}
    }
  },
}
