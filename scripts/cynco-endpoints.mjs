/**
 * Which engine a mission driver is talking to.
 *
 * The bridge takes ONE client at a time, on purpose — see the 409 in
 * engine/bridge/server.ts, and the TUI it was displacing. So two waves cannot
 * share an engine, and running waves in parallel means running a second daemon:
 *
 *   CYNCO_HOME=~/.cynco-b LOCALCODE_WS_PORT=9170 bun run engine/main.ts
 *
 * `CYNCO_HOME` (engine/paths.ts) is the single seam for every piece of on-disk
 * state, tokens.json included, so a second daemon pointed at a second home
 * shares no mutable file with the first. Nothing else needs isolating: the
 * module-level singletons a second WS client would have collided on
 * (`globalContract`, `globalAskBroker`) are per-PROCESS, and two processes do
 * not have that problem at all.
 *
 * That leaves the port, which is this module. The dashboard binds the bridge's
 * bound port plus one (engine/main.ts), so one number configures both the WS
 * bridge and the governance/run API — spelling them separately is a way for a
 * second wave to drive its own engine while reading the first wave's
 * governance.
 */

const DEFAULT_PORT = 9160

/**
 * Resolve the engine endpoints from an environment.
 *
 * Takes `env` rather than reading `process.env` so the resolution can be
 * measured. Throws on a value that is not a port: `parseInt('abc')` is NaN and
 * template interpolation will happily spell `ws://localhost:NaN`, which fails
 * as something indistinguishable from a dead engine — at the far end of a
 * dispatch, hours after the one moment it was cheap to fix.
 */
export function engineEndpoints(env) {
  const pick = () => {
    for (const name of ['CYNCO_ENGINE_PORT', 'LOCALCODE_WS_PORT']) {
      const raw = env[name]
      // An empty value is unset. `CYNCO_ENGINE_PORT=$SOME_UNSET_VAR` is an
      // ordinary accident, and `??` alone would take '' and parse it to NaN.
      if (raw !== undefined && raw !== '') return { name, raw }
    }
    return { name: 'default', raw: String(DEFAULT_PORT) }
  }

  const { name, raw } = pick()
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name}=${JSON.stringify(raw)} is not a TCP port (want an integer 1-65535)`)
  }

  return {
    port,
    source: name,
    ws: `ws://localhost:${port}`,
    governance: `http://localhost:${port + 1}/api/governance`,
    run: `http://localhost:${port + 1}/api/run`,
  }
}
