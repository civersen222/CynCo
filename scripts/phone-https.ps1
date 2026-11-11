<#
.SYNOPSIS
  HTTPS for the phone's dashboard page, on this machine's tailnet name, so the page can be installed.

.DESCRIPTION
  `tailscale serve` terminates TLS on <this-machine>.<tailnet>.ts.net and forwards to a port on
  127.0.0.1 (it proxies to 127.0.0.1 only). That port must be the dashboard's HTTPS proxy listener
  (LOCALCODE_DASHBOARD_PROXY_PORT), on which every client must be a paired device. It must never be
  the desk's listener (9161): a forwarded request arrives there from 127.0.0.1 and would be served
  the desk's page, shared token included. This script refuses to point serve anywhere that does not
  answer like the proxy listener.

  Without -Apply it changes nothing: it prints what is set, what is missing and what it would run.
  Design: docs/decisions/2026-10-22-phone-access.md, amendment "HTTPS and an installable page".

.EXAMPLE
  scripts\phone-https.ps1                 # dry run: what is set, what would run
  scripts\phone-https.ps1 -Apply          # first run: sets the variable (then restart the engine)
  scripts\phone-https.ps1 -Apply          # second run: starts tailscale serve
  scripts\phone-https.ps1 -Off            # stop serving; the variable stays
#>
param(
  [ValidateRange(1, 65535)][int]$ProxyPort = 9443,
  [switch]$Apply,
  [switch]$Off
)

$ErrorActionPreference = 'Stop'
$var = 'LOCALCODE_DASHBOARD_PROXY_PORT'

function Say([string]$mark, [string]$text) { Write-Host ("{0,-6} {1}" -f $mark, $text) }

# ── Tailscale: this machine's name, and whether the tailnet issues certificates ──
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) { Say 'STOP' 'tailscale is not on PATH.'; exit 1 }
$status = (& tailscale status --json | Out-String | ConvertFrom-Json)
$name = ([string]$status.Self.DNSName).TrimEnd('.')
$certs = @($status.CertDomains | Where-Object { $_ })
if (-not $name) { Say 'STOP' 'Tailscale reports no MagicDNS name for this machine. Is it logged in?'; exit 1 }
Say 'ok' "this machine on the tailnet: $name"

if ($Off) {
  Say 'run' 'tailscale serve --https=443 off'
  & tailscale serve --https=443 off
  & tailscale serve status
  exit 0
}

# ── What answers on the port now ──
# /pair exists only for a client the dashboard treats as remote. On the proxy listener every client
# is remote, so it answers 200; on the desk's listener a request from this machine gets 404. That
# difference is the check that serve is about to be pointed at the right port. Asked first, so a
# desk port stops the script before anything is set.
$probe = 'no answer'
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ProxyPort/pair" -UseBasicParsing -TimeoutSec 5
  $probe = "$($r.StatusCode)"
} catch {
  if ($_.Exception.Response) { $probe = "$([int]$_.Exception.Response.StatusCode)" }
}
if ($probe -eq '404') {
  Say 'STOP' "http://127.0.0.1:$ProxyPort/pair answers 404: that is a DESK listener. Serve must never point at it; pick another -ProxyPort."
  exit 1
}
$listenerReady = ($probe -eq '200')

if ($certs.Count -eq 0) {
  Say 'TODO' 'HTTPS certificates are not enabled for this tailnet.'
  Say '' '  Open https://login.tailscale.com/admin/dns and press "Enable HTTPS" (MagicDNS must be on), then run this again.'
  $certsReady = $false
} else {
  Say 'ok' ("certificates are issued for: " + ($certs -join ', '))
  $certsReady = $true
}

# ── The engine's proxy listener: the variable, then whether the port answers like it ──
$set = [Environment]::GetEnvironmentVariable($var, 'User')
$varReady = ($set -eq "$ProxyPort")
if ($varReady) {
  Say 'ok' "$var=$set (user variable)"
} elseif ($Apply) {
  if ($probe -ne 'no answer') {
    Say 'STOP' "something other than the dashboard answers on 127.0.0.1:$ProxyPort (HTTP $probe); pick another -ProxyPort."
    exit 1
  }
  [Environment]::SetEnvironmentVariable($var, "$ProxyPort", 'User')
  Say 'set' "$var=$ProxyPort (user variable; was '$set')"
  Say 'NEXT' 'Restart the engine so it binds the listener, then run this script again:'
  Say '' '  scripts\cynco-services.ps1 stop engine'
  Say '' '  scripts\cynco-services.ps1 start engine'
  exit 0
} else {
  Say 'TODO' "$var is '$set'; -Apply would set it to $ProxyPort as a user variable (the engine then needs a restart)."
}

if ($listenerReady) {
  Say 'ok' "http://127.0.0.1:$ProxyPort/pair answers 200: this is the proxy listener (every client on it must be paired)"
} else {
  Say 'TODO' "http://127.0.0.1:$ProxyPort/pair: $probe. The engine is not listening there yet (variable set? engine restarted?)."
}

# ── tailscale serve ──
$serve = "tailscale serve --bg --https=443 http://127.0.0.1:$ProxyPort"
Say 'now' 'tailscale serve status:'
& tailscale serve status

if (-not ($certsReady -and $varReady -and $listenerReady)) {
  Say 'wait' "not ready; when the TODO lines above are done this would run:  $serve"
  exit 0
}
if (-not $Apply) {
  Say 'dry' "ready. -Apply would run:  $serve"
  exit 0
}
Say 'run' $serve
& tailscale serve --bg --https=443 "http://127.0.0.1:$ProxyPort"
& tailscale serve status
Say 'done' "On the phone open  https://$name/  (Tailscale on). It asks to pair once: the https address is a new"
Say '' '  origin, so the token stored for the old http address does not apply. Code: Config -> Phone access on the desk.'
Say '' '  Then Chrome menu -> "Install app" (or "Add to Home screen"). The old http://100.x.y.z:9161 address keeps working.'
