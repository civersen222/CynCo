/**
 * scripts/phone-https.ps1 puts the dashboard behind `tailscale serve`. The one
 * thing it must never do is point serve at the desk's listener: a forwarded
 * request arrives there from 127.0.0.1 and is handed the shared token. The
 * script cannot be run by the suite (it changes Tailscale and a user
 * variable), so what is pinned is its text: the order of its checks and the
 * only commands that change anything.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'phone-https.ps1'), 'utf-8')
const at = (needle) => { const i = src.indexOf(needle); expect(i, `not found: ${needle}`).toBeGreaterThan(-1); return i }

describe('scripts/phone-https.ps1', () => {
  it('serves only to the port it was given, on 127.0.0.1, over the tailnet (never Funnel)', () => {
    const serveLines = src.split(/\r?\n/).filter(l => /^\s*& tailscale (serve|funnel)\b/.test(l))
    expect(serveLines.map(l => l.trim())).toEqual([
      '& tailscale serve --https=443 off',
      '& tailscale serve status',
      '& tailscale serve status',
      '& tailscale serve --bg --https=443 "http://127.0.0.1:$ProxyPort"',
      '& tailscale serve status',
    ])
    expect(src).not.toMatch(/tailscale funnel/i)
    expect(src).not.toMatch(/http:\/\/127\.0\.0\.1:9161/)
    expect(src).not.toMatch(/0\.0\.0\.0/)
  })

  it('asks what answers on the port before it sets anything, and stops when it is a desk listener', () => {
    const probe = at('Invoke-WebRequest -Uri "http://127.0.0.1:$ProxyPort/pair"')
    const stop = at("if ($probe -eq '404') {")
    const setVar = at('[Environment]::SetEnvironmentVariable($var, "$ProxyPort", \'User\')')
    const serve = at('& tailscale serve --bg --https=443')
    expect(probe).toBeLessThan(stop)
    expect(stop).toBeLessThan(setVar)
    expect(setVar).toBeLessThan(serve)
    expect(src.slice(stop, stop + 300)).toMatch(/exit 1/)
  })

  it('changes nothing without -Apply: the variable and serve both sit behind it', () => {
    const setVar = at('[Environment]::SetEnvironmentVariable(')
    expect(src.lastIndexOf('} elseif ($Apply) {', setVar)).toBeGreaterThan(-1)
    expect(src.slice(src.lastIndexOf('} elseif ($Apply) {', setVar), setVar)).not.toMatch(/\} else \{/)
    const serve = at('& tailscale serve --bg --https=443')
    const gate = src.lastIndexOf('if (-not $Apply) {', serve)
    expect(gate).toBeGreaterThan(-1)
    expect(src.slice(gate, serve)).toMatch(/exit 0/)
    // And serve runs only when certificates, the variable and the listener are all in place.
    const ready = src.lastIndexOf('if (-not ($certsReady -and $varReady -and $listenerReady)) {', serve)
    expect(ready).toBeGreaterThan(-1)
    expect(src.slice(ready, gate)).toMatch(/exit 0/)
  })

  it('the listener counts as ready only when /pair answers 200', () => {
    expect(src).toContain("$listenerReady = ($probe -eq '200')")
  })
})
