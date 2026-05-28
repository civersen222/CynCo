type MergePrompt = { system: string; user: string }

export function attemptSemanticMerge(
  fileContent: string,
  oldStr: string,
  newStr: string,
  filePath: string,
  attemptedFiles: Set<string>,
): MergePrompt | null {
  if (attemptedFiles.has(filePath)) return null
  attemptedFiles.add(filePath)
  const lineCount = fileContent.split('\n').length
  if (lineCount > 500) return null
  return {
    system:
      'You are a code merger. Apply the intended edit to the current file. Return ONLY the complete updated file content. No markdown fences, no explanation.',
    user: `Current file:\n\`\`\`\n${fileContent}\n\`\`\`\n\nIntended edit — replace:\n\`\`\`\n${oldStr}\n\`\`\`\nWith:\n\`\`\`\n${newStr}\n\`\`\``,
  }
}
