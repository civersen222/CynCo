/**
 * What makes the dashboard page installable on the phone: a web manifest and
 * two icons. Chrome offers "Install app" for a page served over HTTPS whose
 * manifest names it, gives a start URL, asks for a standalone display and
 * lists a 192 px and a 512 px icon; no service worker is needed for that.
 *
 * Both are static and say nothing about the engine, so server.ts answers them
 * without a token (the browser fetches a manifest and its icons with no
 * Authorization header). The icons are drawn here, once per size, with the
 * PNG encoder the engine already depends on: no binary asset in the tree.
 */
import { PNG } from 'pngjs'

export const APP_ICON_SIZES = [192, 512] as const
export type AppIconSize = (typeof APP_ICON_SIZES)[number]

export type WebManifest = {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: 'standalone'
  background_color: string
  theme_color: string
  icons: { src: string; sizes: string; type: 'image/png'; purpose: string }[]
}

/** The page's own dark background and teal, as in index.html. */
const BACKGROUND = '#1e1e1e'
const TEAL: [number, number, number] = [0x4e, 0xc9, 0xb0]
const DARK: [number, number, number] = [0x1e, 0x1e, 0x1e]

export function webManifest(): WebManifest {
  return {
    id: '/',
    name: 'CynCo',
    short_name: 'CynCo',
    description: 'CynCo on this machine: chat, projects and what ran while you were away.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    // `maskable`: opaque edge to edge with the mark inside the safe zone, so Android may cut it to its own shape.
    icons: APP_ICON_SIZES.map(size => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' as const, purpose: 'any maskable' })),
  }
}

/** True when `n` is a size an icon route exists for. */
export function isAppIconSize(n: number): n is AppIconSize {
  return (APP_ICON_SIZES as readonly number[]).includes(n)
}

const drawn = new Map<number, Buffer>()

/**
 * The icon: a teal "C" — an open ring — on the page's dark background, with a
 * dot where the ring opens. Coverage is sampled 4×4 per pixel so the curve is
 * smooth at 192 px. The mark stays within the middle 60% of the square, inside
 * a maskable icon's safe zone.
 */
export function appIconPng(size: AppIconSize): Buffer {
  const cached = drawn.get(size)
  if (cached) return cached
  const png = new PNG({ width: size, height: size })
  const SS = 4
  const c = size / 2
  const outer = size * 0.30
  const inner = size * 0.19
  const dot = size * 0.055
  // The ring is open to the right for 35 degrees either side of the x axis.
  const gap = (35 * Math.PI) / 180
  const dotX = c + (outer + inner) / 2
  const inMark = (x: number, y: number): boolean => {
    const dx = x - c
    const dy = y - c
    const r = Math.hypot(dx, dy)
    if (r <= outer && r >= inner && Math.abs(Math.atan2(dy, dx)) > gap) return true
    return Math.hypot(x - dotX, y - c) <= dot
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inMark(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++
        }
      }
      const a = hit / (SS * SS)
      const o = (y * size + x) * 4
      png.data[o] = Math.round(DARK[0] + (TEAL[0] - DARK[0]) * a)
      png.data[o + 1] = Math.round(DARK[1] + (TEAL[1] - DARK[1]) * a)
      png.data[o + 2] = Math.round(DARK[2] + (TEAL[2] - DARK[2]) * a)
      png.data[o + 3] = 255
    }
  }
  const out = PNG.sync.write(png)
  drawn.set(size, out)
  return out
}
