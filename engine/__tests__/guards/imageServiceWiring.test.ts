/**
 * main.ts must build the image service, hand it to the loop, probe it at start
 * and shut it down before the process exits (F174).
 *
 * Every behaviour of `engine/imagegen` is pinned against a fake ComfyUI, and
 * `uiRenderWiring.test.ts` pins the loop with a fake annotator. None of that
 * loads main.ts, and the loop is built to behave exactly as before when no
 * annotator is passed: delete `images: imageService` and RenderUI Images draw
 * as "picture not generated" while every suite stays green. The same holds for
 * the dashboard half of the service's emit (no card would ever fill in), the
 * startup probe (the operator's only `[imagegen] ready:` / `not ready:` line)
 * and the shutdown (pictures in flight left `running` on ComfyUI and in their
 * sidecars). This guard reads those four lines, in the shape of
 * `dashboardPortFollowsTheBridge.test.ts` "main.ts startup wiring".
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/** Full-line comments only: the block above the construction describes it in prose. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const here = dirname(fileURLToPath(import.meta.url))
const src = stripLineComments(readFileSync(join(here, '..', '..', 'main.ts'), 'utf-8').split('\r\n').join('\n'))

/**
 * From `start` at the start of a line (the ablation runner builds its own,
 * indented loop that needs no pictures) to the first `end` after it, bounded
 * so a moved block fails loudly.
 */
function block(start: string, end: string, max: number): string {
  const from = src.indexOf('\n' + start)
  expect(from, `\`${start}\` is not in main.ts under the shape this guard reads`).toBeGreaterThan(-1)
  const to = src.indexOf(end, from)
  expect(to, `\`${start}\` no longer ends at \`${JSON.stringify(end)}\``).toBeGreaterThan(from)
  const body = src.slice(from, to + end.length)
  expect(body.length, `\`${start}\` grew past what this guard was written for`).toBeLessThan(max)
  return body
}

describe('main.ts wires the image service (F174)', () => {
  it('builds one ImageService whose ui.image events reach both sockets', () => {
    expect(src.match(/new ImageService\(/g), 'main.ts must build exactly one ImageService').toHaveLength(1)
    const ctor = src.match(/^const imageService = new ImageService\(\{[^\n]*\}\)$/m)
    expect(ctor, 'the ImageService construction moved or changed shape').not.toBeNull()
    expect(ctor![0], 'the TUI socket never hears ui.image').toContain('wsServer.emit(e)')
    expect(
      ctor![0],
      "the dashboard never hears ui.image: the page draws every picture, so no card would ever fill in",
    ).toContain('dashboardServer?.broadcast(e)')
  })

  it('hands it to the loop that runs the turns', () => {
    const loop = block('const loop = new ConversationLoop({', '\n})', 3000)
    expect(
      loop,
      'without `images` the loop takes its no-annotator path: every prompted Image draws "picture not generated" and no test notices',
    ).toMatch(/^\s+images: imageService,?$/m)
    const built = src.indexOf('\nconst imageService = new ImageService(')
    expect(built).toBeGreaterThan(-1)
    expect(built, 'the service must exist before the loop is built').toBeLessThan(src.indexOf('\nconst loop = new ConversationLoop({'))
  })

  it('probes the server in the background at start', () => {
    expect(src, 'the startup probe is the operator\'s only "[imagegen] ready:" / "not ready:" line').toMatch(/^void imageService\.probe\(\)$/m)
  })

  it('shuts it down inside cleanShutdown, before the process exits', () => {
    const shutdown = block('async function cleanShutdown(', '\n}\n', 6000)
    const at = shutdown.indexOf('await imageService.shutdown()')
    expect(at, 'pictures in flight would stay running on ComfyUI and read "running" in their sidecars').toBeGreaterThan(-1)
    expect(at, 'the shutdown must run before process.exit, or it never runs').toBeLessThan(shutdown.indexOf('process.exit('))
  })
})
