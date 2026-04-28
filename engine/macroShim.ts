/**
 * Runtime shim for build-time MACRO constants.
 *
 * Macro shim — provides runtime values for build-time macros's
 * bundler at compile time. This shim defines them as globals so the code
 * runs without the full build pipeline.
 */

declare global {
  const MACRO: {
    VERSION: string
    BUILD_TIME: string | undefined
    ISSUES_EXPLAINER: string
    FEEDBACK_CHANNEL: string
  }
}

;(globalThis as any).MACRO = {
  VERSION: '0.1.0-localcode',
  BUILD_TIME: undefined,
  ISSUES_EXPLAINER: 'report the issue at https://github.com/civersen222/CynCo/issues',
  FEEDBACK_CHANNEL: '#localcode',
}

export {}
