type ErrorType = 'syntax' | 'runtime' | 'permission' | 'not_found' | 'timeout' | 'dependency' | 'unknown'
type Diagnosis = { type: ErrorType; hint: string; formatted: string }

const PATTERNS: Array<{ type: ErrorType; pattern: RegExp; hint: string }> = [
  { type: 'syntax', pattern: /SyntaxError|parse error|unexpected token|unexpected end/i, hint: 'Check syntax near the indicated line' },
  { type: 'dependency', pattern: /ModuleNotFoundError|Cannot find module|ImportError|no module named/i, hint: 'Install the missing package first' },
  { type: 'runtime', pattern: /TypeError|ReferenceError|NullPointerException|segfault|SIGSEGV|AttributeError|NameError|KeyError|IndexError/i, hint: 'Variable or function may be undefined or wrong type' },
  { type: 'permission', pattern: /EACCES|Permission denied|Operation not permitted|EPERM/i, hint: 'Check file permissions or run with elevated access' },
  { type: 'not_found', pattern: /command not found|ENOENT|No such file|not recognized as/i, hint: 'Check the command/path exists and is spelled correctly' },
  { type: 'timeout', pattern: /timed? out|exceeded|SIGKILL|SIGTERM/i, hint: 'Command took too long — try a simpler version or add limits' },
]

export function diagnoseError(stderr: string): Diagnosis {
  for (const { type, pattern, hint } of PATTERNS) {
    if (pattern.test(stderr)) return { type, hint, formatted: `[ERROR: ${type}] ${hint}\n\n${stderr}` }
  }
  return { type: 'unknown', hint: 'Check the error output above', formatted: `[ERROR: unknown] Check the error output above\n\n${stderr}` }
}
