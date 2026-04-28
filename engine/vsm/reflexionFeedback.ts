/**
 * Reflexion Feedback — specific error corrections, not generic warnings.
 * Inspired by Reflexion (Shinn et al.) — verbal reinforcement learning.
 * Cybernetic grounding: S3* audit — inspecting S1 output, feeding corrections via S2.
 */

export function generateReflection(toolName: string, isError: boolean, output: string): string {
  if (!isError) return ''
  const out = output.toLowerCase()

  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    if (out.includes('not found') || out.includes('old_string') || out.includes('no match')) {
      return 'Edit failed: the text you tried to match does not exist in the file. Use Read to see the exact current content, then copy the precise text to match.'
    }
    if (out.includes('not unique')) {
      return 'Edit failed: the text matches multiple locations. Include more surrounding context in old_string to make it unique.'
    }
  }

  if (toolName === 'Bash') {
    if (out.includes('command not found') || out.includes('not recognized')) {
      const cmdMatch = output.match(/command not found:\s*(\S+)|'(\S+)' is not recognized/)
      const cmd = cmdMatch?.[1] ?? cmdMatch?.[2] ?? 'the command'
      return `Command ${cmd} is not installed. Check availability with 'which ${cmd}' or use an alternative.`
    }
    if (out.includes('fail') && (out.includes('assert') || out.includes('test') || out.includes('expect'))) {
      return 'Tests failed. Read the failing test file to understand what it expects, then fix your implementation to match.'
    }
    if (out.includes('syntaxerror') || out.includes('syntax error')) {
      return 'Syntax error in the code. Read the file around the reported line number and fix the syntax.'
    }
    if (out.includes('modulenotfounderror') || out.includes('cannot find module')) {
      return 'Missing module/import. Check the import path and ensure the file exists at that location.'
    }
  }

  if (toolName === 'Write') {
    if (out.includes('eacces') || out.includes('permission')) {
      return 'Write failed: permission denied. The file may be read-only or the directory may not exist. Check the path.'
    }
  }

  return `Tool ${toolName} failed. Read the error output carefully and adjust your approach.`
}
