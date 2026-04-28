export type Diagnostic = {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source: string  // e.g., 'typescript', 'python'
}

export type LSPServerConfig = {
  language: string
  command: string          // e.g., 'typescript-language-server'
  args: string[]           // e.g., ['--stdio']
  fileExtensions: string[] // e.g., ['.ts', '.tsx']
}
