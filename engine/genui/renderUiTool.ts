/**
 * engine/genui/renderUiTool.ts — the `RenderUI` tool.
 *
 * The model hands it a spec; it validates and answers with what will draw and
 * what could not. It writes nothing and asks nobody (tier `auto`, risk low).
 * The frame the page renders is emitted by the conversation loop after this
 * returns (`ui.render`, conversationLoop.ts), because only the loop knows the
 * tool call's id — the surface the page keys on. `isError` is reserved for a
 * spec with nothing drawable: a cosmetic issue must not trip the per-tool
 * circuit breaker on the one tool whose output the user is looking at.
 *
 * Extended (`core: false`) in a coding session — the model loads it with
 * load_tools, which is also when the RENDER_UI prompt section appears — and
 * always offered in a project chat (projects/profile.ts PROJECT_TOOL_NAMES).
 */
import type { ToolImpl } from '../tools/types.js'
import { validateSpec, isSurfaceId, LIMITS } from './spec.js'

/** The envelope llama-server turns into a grammar; props stay untyped on purpose (design A6). */
export const RENDER_UI_INPUT_SCHEMA: ToolImpl['inputSchema'] = {
  type: 'object',
  properties: {
    surface: {
      type: 'string',
      description: 'Short id for this surface (letters, digits, - or _). Reuse an id to replace that surface in place.',
    },
    spec: {
      type: 'object',
      description: 'The UI: { root: "<id>", elements: { "<id>": { type, props, children } } } — see the RENDER_UI section of your instructions.',
      required: ['root', 'elements'],
      properties: {
        root: { type: 'string' },
        elements: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string' },
              props: { type: 'object' },
              children: { type: 'array', items: { type: 'string' } },
              visible: { type: 'object' },
              tab: { type: 'string' },
            },
          },
        },
      },
    },
  },
  required: ['spec'],
}

export function renderUiResultText(count: number, errors: string[]): string {
  const head = count === 1 ? 'Rendered 1 element' : `Rendered ${count} elements`
  if (!errors.length) return `${head}.`
  return `${head}.\nIssues (fix these in your next call rather than resending the same spec):\n${errors.map(e => `- ${e}`).join('\n')}`
}

export const renderUiTool: ToolImpl = {
  name: 'RenderUI',
  description: 'Draw structured UI in the user\'s dashboard — tables, plans, charts, key facts, forms, buttons — from a small JSON spec (see RENDER_UI in your instructions). Clicks come back to you as the user\'s next message.',
  inputSchema: RENDER_UI_INPUT_SCHEMA,
  tier: 'auto',
  core: false,
  execute: async (input) => {
    const spec = input.spec !== undefined ? input.spec : input
    const result = validateSpec(spec)
    const errors = [...result.errors]
    if (input.surface !== undefined && !isSurfaceId(input.surface)) {
      errors.push(`surface "${String(input.surface).slice(0, 60)}" must match ${LIMITS.idPattern}; the call id was used instead`)
    }
    if (!result.spec) {
      return { output: `Nothing could be drawn.\n${errors.map(e => `- ${e}`).join('\n')}`, isError: true }
    }
    return { output: renderUiResultText(result.count, errors), isError: false }
  },
}
