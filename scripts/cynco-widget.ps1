# CynCo desk widget: a small, ordinary desktop window (it minimises, sits in the
# taskbar, goes behind other programs, and remembers where it was left) that says
# whether CynCo (the interactive engine + dashboard) and Fantasyman (the liveness
# daemon, ntfy and the dynasty approval listener) are running and reachable from
# the phone, with one button each to start or stop them, plus a GPU row that says
# who holds the RTX 5090 and lets the owner pause/resume or stop the daemon's
# running pass, plus one glance row per mission under the GPU row.
# Launch with scripts\cynco-widget.cmd (WPF needs an STA PowerShell).
#
#   CynCo ON      = the dashboard answers on 127.0.0.1:<port>
#   CynCo remote  = the dashboard also answers on the Tailscale address
#   Fantasyman ON = daemon + listener running here (cynco-services.ps1)
#   Fantasyman remote = Tailscale is up and the doorman's ntfy answers (slice 6: ntfy moved there)
#   GPU running   = a daemon one-shot (bun engine\main.ts --run-task ...) is up:
#                   "<trigger> since HH:MM, done by HH:MM, used/total GB"
#   GPU paused    = daemon-control.json says paused and a mission's state.json
#                   carries the interrupted pass: "paused: <trigger>, N min left"
#   GPU free      = "free - next HH:MM <trigger>" from the missions' nextFire
#
#   Mission rows  = one per folder under the missions dir that has a mission.json:
#                   "<id>: next <name> HH:mm - last <name> ok|skip|FAIL HH:mm"; next skips
#                   triggers that schedule.json marks enabled:false; while the daemon is
#                   paused the row says "<id>: paused since HH:mm (<by>)". The first row
#                   carries a Missions... button that opens the dashboard #missions tab.
#
# Pause/resume speak to the daemon through $env:USERPROFILE\.cynco\daemon-control.json
# ({"paused": true|false, "requestedAt": "<ISO 8601 UTC>", "by": "widget"}, written atomically).
# The window position is kept in $env:USERPROFILE\.cynco\widget.json ({"left": N, "top": N}).
# Stop is taskkill /F /T on the one-shot; its llama-server dies with it.
#
# Starting CynCo while a daemon one-shot is running is refused: a new engine
# kills whatever llama-server answers on the model port as "stale" (F182).
#
#   -Probe        compute the GPU row once, print "<dot>|<text>|<button>", then one
#                 "mission|<id>|<next or ->|<last or ->" line per mission, exit
#   -MissionsDir  where the missions live (tests point it at a copy)
#   -ControlFile  the daemon control file (tests point it at a temp path)
#   -StateFile    the window position file (tests point it at a temp path)
#
# Keep every string literal ASCII: PS 5.1 reads this file as ANSI.
param(
  [switch] $Probe,
  [string] $MissionsDir = (Join-Path $env:USERPROFILE '.cynco\missions'),
  [string] $ControlFile = (Join-Path $env:USERPROFILE '.cynco\daemon-control.json'),
  [string] $StateFile   = (Join-Path $env:USERPROFILE '.cynco\widget.json')
)
$ErrorActionPreference = 'Continue'

$repo      = 'C:\Users\civer\localcode'
$services  = Join-Path $PSScriptRoot 'cynco-services.ps1'
$engineLog = Join-Path $env:USERPROFILE '.cynco\engine-widget.log'
$wsPort    = if ($env:LOCALCODE_WS_PORT) { [int]$env:LOCALCODE_WS_PORT } else { 9160 }
$dashPort  = $wsPort + 1
$hosts     = ($env:LOCALCODE_DASHBOARD_HOST -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $hosts) { $hosts = @('127.0.0.1') }
$tsHost    = $hosts | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne 'localhost' } | Select-Object -First 1
$defaultTimeoutMs = 2700000   # 45 min, what the daemon writes in task files when it is not told otherwise

function Test-Http([string]$url) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; return $r.StatusCode -eq 200 } catch { return $false }
}
function Test-Tcp([string]$addr, [int]$port) {
  try { $c = New-Object Net.Sockets.TcpClient; $ok = $c.ConnectAsync($addr, $port).Wait(1500) -and $c.Connected; $c.Close(); return $ok } catch { return $false }
}
function Get-Procs { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } }
function Get-EngineProc($procs) {
  $procs | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'engine[\\/]main\.ts' -and $_.CommandLine -notmatch '--run-task' } | Select-Object -First 1
}
function Get-OneShotProc($procs) {
  # prefer the bun.exe itself (that is the pid taskkill /T should take down), else any wrapper that carries the command line
  $all = @($procs | Where-Object { $_.CommandLine -match 'engine[\\/]main\.ts' -and $_.CommandLine -match '--run-task' })
  $bun = $all | Where-Object { $_.Name -eq 'bun.exe' } | Select-Object -First 1
  if ($bun) { return $bun }
  return ($all | Select-Object -First 1)
}
# The engine's own view of the GPU: cold / loading / warm / waiting (+ which one-shot holds it).
# /api/session is token-gated; the inference token lives in ~/.cynco/tokens.json (this user's file).
function Get-ModelState {
  try {
    $j = Get-Content (Join-Path $env:USERPROFILE '.cynco\tokens.json') -Raw | ConvertFrom-Json
    $t = $j.tokens | Where-Object { $_.name -eq 'inference' -or ($_.scopes -contains 'inference') -or ($_.scope -eq 'inference') } | Select-Object -First 1
    $secret = if ($t.secret) { $t.secret } elseif ($t.token) { $t.token } else { $null }
    if (-not $secret) { return $null }
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:$dashPort/api/session" -Headers @{ Authorization = "Bearer $secret" } -TimeoutSec 2
    if ($s.busy -and $s.busy.triggerId) { return "$($s.modelState) ($($s.busy.triggerId), ~$([math]::Ceiling($s.busy.remainingMs / 60000)) min)" }
    return $s.modelState
  } catch { return $null }
}

function Get-TailscaleUp {
  try { $j = & tailscale status --json 2>$null | ConvertFrom-Json; return $j.BackendState -eq 'Running' } catch { return $false }
}
function Get-FantasyState($procs) {
  $up = @()
  if ($procs | Where-Object { $_.CommandLine -match 'engine\\daemon\\main|engine/daemon/main' }) { $up += 'daemon' }
  if ($procs | Where-Object { $_.CommandLine -match 'approval_listener\.py' })                    { $up += 'listener' }
  return $up
}

# ---- GPU row -----------------------------------------------------------------
function Read-Json([string]$path) {
  try { if ($path -and (Test-Path -LiteralPath $path)) { return (Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) } } catch {}
  return $null
}
function Get-GpuMem {
  # "29755, 32607" (MiB) -> "29.8/32.6 GB"; $null when nvidia-smi is missing or unhappy
  try {
    $line = @(& nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>$null) | Select-Object -First 1
    if (-not $line) { return $null }
    $p = "$line" -split ','
    if ($p.Count -lt 2) { return $null }
    return ('{0:0.0}/{1:0.0} GB' -f ([double]$p[0].Trim() / 1000), ([double]$p[1].Trim() / 1000))
  } catch { return $null }
}
function Get-Missions {
  # one record per mission folder: the trigger ids mission.json declares (minus the ones schedule.json
  # marks enabled:false), the parsed state.json and the folder
  if (-not (Test-Path -LiteralPath $MissionsDir)) { return @() }
  $out = @()
  foreach ($d in Get-ChildItem -LiteralPath $MissionsDir -Directory) {
    $m = Read-Json (Join-Path $d.FullName 'mission.json')
    if (-not $m) { continue }
    $ids = @($m.triggers | ForEach-Object { $_.id } | Where-Object { $_ })
    $sched = Read-Json (Join-Path $d.FullName 'schedule.json')
    if ($sched -and $sched.triggers) {
      $off = @($sched.triggers.PSObject.Properties | Where-Object { $_.Value -and $_.Value.enabled -eq $false } | ForEach-Object { $_.Name })
      $ids = @($ids | Where-Object { $off -notcontains $_ })
    }
    $out += [pscustomobject]@{ Id = $d.Name; Dir = $d.FullName; Triggers = $ids; State = (Read-Json (Join-Path $d.FullName 'state.json')) }
  }
  return $out
}
function Get-NextFire($missions) {
  # the earliest nextFire over the missions, counting only ids mission.json still declares and schedule.json leaves on
  # (state.json keeps the nextFire of triggers that no longer exist)
  $best = $null
  foreach ($m in $missions) {
    if (-not $m.State -or -not $m.State.nextFire) { continue }
    foreach ($p in $m.State.nextFire.PSObject.Properties) {
      if ($m.Triggers -notcontains $p.Name) { continue }
      $t = [datetime]::MinValue
      if (-not [datetime]::TryParse([string]$p.Value, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$t)) { continue }
      $t = $t.ToLocalTime()
      if (-not $best -or $t -lt $best.At) { $best = @{ At = $t; TriggerId = $p.Name } }
    }
  }
  return $best
}
function Format-When([datetime]$t) {
  if ($t.Date -eq (Get-Date).Date) { return $t.ToString('HH:mm') }
  return $t.ToString('ddd HH:mm')
}
function Get-PausedPass($missions) {
  # while the daemon holds an interrupted pass, that mission's state.json carries paused: { triggerId, remainingMs, pausedAt }
  foreach ($m in $missions) {
    if ($m.State -and $m.State.paused -and $m.State.paused.triggerId) { return $m.State.paused }
  }
  return $null
}
function Get-ControlPaused {
  $c = Read-Json $ControlFile
  return [bool]($c -and $c.paused -eq $true)
}
function Get-TriggerName([string]$id) {
  # dynasty-tin-trades -> "tin trades": drop the first dash-segment, dashes to spaces
  return (($id -replace '^[^-]*-', '') -replace '-', ' ')
}
function Get-LastRun([string]$dir) {
  # the newest runs.jsonl record by ts, from the last 64 KiB only; torn lines are skipped
  $path = Join-Path $dir 'runs.jsonl'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = $null
  try {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    try {
      $start = [math]::Max(0, $fs.Length - 65536)
      [void]$fs.Seek($start, 'Begin')
      $buf = New-Object byte[] ($fs.Length - $start)
      $n = $fs.Read($buf, 0, $buf.Length)
      $text = [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      if ($start -gt 0) { $nl = $text.IndexOf("`n"); $text = if ($nl -ge 0) { $text.Substring($nl + 1) } else { '' } }
    } finally { $fs.Close() }
  } catch { return $null }
  $best = $null
  foreach ($line in ($text -split "`n")) {
    if (-not $line.Trim()) { continue }
    try { $r = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    $t = [datetime]::MinValue
    if (-not $r.ts -or -not [datetime]::TryParse([string]$r.ts, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$t)) { continue }
    if (-not $best -or $t -gt $best.At) { $best = @{ At = $t.ToLocalTime(); Rec = $r } }
  }
  return $best
}
function Get-MissionGlance($mission) {
  # -> @{ Next = '<name> HH:mm' | $null; Last = '<name> ok|skip|FAIL HH:mm' | $null }
  $g = @{ Next = $null; Last = $null }
  $n = Get-NextFire @($mission)
  if ($n) { $g.Next = "$(Get-TriggerName $n.TriggerId) $(Format-When $n.At)" }
  $l = Get-LastRun $mission.Dir
  if ($l) {
    $verdict = if ($l.Rec.ok -eq $false) { 'FAIL' } elseif ([string]$l.Rec.summary -like 'precheck skipped*') { 'skip' } else { 'ok' }
    $g.Last = "$(Get-TriggerName ([string]$l.Rec.triggerId)) $verdict $(Format-When $l.At)"
  }
  return $g
}
function Get-MissionRowText($mission) {
  # -> @{ Dot; Text } for one glance row
  $c = Read-Json $ControlFile
  if ($c -and $c.paused -eq $true) {
    $since = '?'
    $t = [datetime]::MinValue
    if ($c.requestedAt -and [datetime]::TryParse([string]$c.requestedAt, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$t)) { $since = $t.ToLocalTime().ToString('HH:mm') }
    $by = if ($c.by) { [string]$c.by } else { 'unknown' }
    return @{ Dot = '#58a6ff'; Text = "$($mission.Id): paused since $since ($by)" }
  }
  $g = Get-MissionGlance $mission
  if (-not $g.Next -and -not $g.Last) { return @{ Dot = '#666'; Text = "$($mission.Id): no passes yet" } }
  $nx = if ($g.Next) { $g.Next } else { 'nothing' }
  $ls = if ($g.Last) { $g.Last } else { 'none' }
  return @{ Dot = $(if ($g.Next) { '#3fb950' } else { '#666' }); Text = "$($mission.Id): next $nx - last $ls" }
}
function Get-WidgetPos {
  # saved window corner, or $null when there is none or it would be off every screen
  $p = Read-Json $StateFile
  if (-not $p -or $null -eq $p.left -or $null -eq $p.top) { return $null }
  try {
    $l = [double]$p.left; $t = [double]$p.top
    $vx = [System.Windows.SystemParameters]::VirtualScreenLeft;  $vy = [System.Windows.SystemParameters]::VirtualScreenTop
    $vw = [System.Windows.SystemParameters]::VirtualScreenWidth; $vh = [System.Windows.SystemParameters]::VirtualScreenHeight
    if ($l -lt $vx -or $t -lt $vy -or $l -gt ($vx + $vw - 50) -or $t -gt ($vy + $vh - 50)) { return $null }
    return @{ Left = $l; Top = $t }
  } catch { return $null }
}
function Save-WidgetPos([double]$left, [double]$top) {
  # atomic like Write-DaemonControl
  $dir = Split-Path -Parent $StateFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = Join-Path $dir ("widget.$PID.tmp")
  $inv = [cultureinfo]::InvariantCulture
  $json = '{"left": ' + [math]::Round($left).ToString($inv) + ', "top": ' + [math]::Round($top).ToString($inv) + '}'
  [IO.File]::WriteAllText($tmp, $json)
  Move-Item -LiteralPath $tmp -Destination $StateFile -Force
}
function Get-RunningPass($oneShot) {
  # the daemon names the file task-<triggerId>-<stampMs>.json and the stamp is when the pass started;
  # the file itself carries triggerId and timeoutMs, so read those when it is still there
  if (-not $oneShot) { return $null }
  $run = @{ Pid = $oneShot.ProcessId; TriggerId = 'a task'; Start = $null; EndBy = $null }
  $m = [regex]::Match($oneShot.CommandLine, '--run-task\s+"?([^"]*?task-(.+)-(\d{10,})\.json)')
  if (-not $m.Success) { return $run }
  $run.TriggerId = $m.Groups[2].Value
  $timeout = $defaultTimeoutMs
  $task = Read-Json $m.Groups[1].Value
  if ($task) {
    if ($task.triggerId) { $run.TriggerId = [string]$task.triggerId }
    if ($task.timeoutMs)  { $timeout = [long]$task.timeoutMs }
  }
  $run.Start = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$m.Groups[3].Value).LocalDateTime
  $run.EndBy = $run.Start.AddMilliseconds($timeout)
  return $run
}
function Get-GpuState($oneShot) {
  # -> @{ Mode; Dot; Text; Button; Stop (show the Stop button); Pid (one-shot pid) }
  $missions  = @(Get-Missions)
  $ctlPaused = Get-ControlPaused
  $run = Get-RunningPass $oneShot
  if ($run) {
    $since = if ($run.Start) { $run.Start.ToString('HH:mm') } else { '?' }
    $by    = if ($run.EndBy) { $run.EndBy.ToString('HH:mm') } else { '?' }
    $text  = "$($run.TriggerId) since $since, done by $by"
    $mem   = Get-GpuMem
    if ($mem) { $text += ", $mem" }
    if ($ctlPaused) {
      # pause asked for, the daemon has not killed the pass yet
      return @{ Mode = 'pausing'; Dot = '#58a6ff'; Text = "pausing: $text"; Button = 'Resume'; Stop = $true; Pid = $run.Pid }
    }
    return @{ Mode = 'running'; Dot = '#d29922'; Text = $text; Button = 'Pause'; Stop = $true; Pid = $run.Pid }
  }
  $paused = Get-PausedPass $missions
  if ($paused) {
    $left = [math]::Ceiling([double]$paused.remainingMs / 60000)
    return @{ Mode = 'paused'; Dot = '#58a6ff'; Text = "paused: $($paused.triggerId), $left min left"; Button = 'Resume'; Stop = $false; Pid = $null }
  }
  $next = Get-NextFire $missions
  $nextText = if ($next) { "next $(Format-When $next.At) $($next.TriggerId)" } else { 'nothing scheduled' }
  if ($ctlPaused) {
    # paused with nothing interrupted: the GPU is free but the daemon fires nothing until Resume
    return @{ Mode = 'held'; Dot = '#58a6ff'; Text = "held - daemon starts nothing ($nextText)"; Button = 'Release'; Stop = $false; Pid = $null }
  }
  # Hold: nothing is running, but the owner wants the card for a while - the daemon fires nothing until Release
  return @{ Mode = 'free'; Dot = '#3fb950'; Text = "free - $nextText"; Button = 'Hold'; Stop = $false; Pid = $null }
}
function Write-DaemonControl([bool]$paused) {
  # atomic: temp file in the same folder, then Move-Item -Force over the control file
  $dir = Split-Path -Parent $ControlFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp  = Join-Path $dir ("daemon-control.$PID.tmp")
  $flag = if ($paused) { 'true' } else { 'false' }
  $json = '{"paused": ' + $flag + ', "requestedAt": "' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + '", "by": "widget"}'
  [IO.File]::WriteAllText($tmp, $json)   # UTF-8 without BOM
  Move-Item -LiteralPath $tmp -Destination $ControlFile -Force
}

if ($Probe) {
  $s = Get-GpuState (Get-OneShotProc (Get-Procs))
  Write-Output "$($s.Dot)|$($s.Text)|$($s.Button)"
  foreach ($m in @(Get-Missions)) {
    $g = Get-MissionGlance $m
    $nx = if ($g.Next) { $g.Next } else { '-' }
    $ls = if ($g.Last) { $g.Last } else { '-' }
    Write-Output "mission|$($m.Id)|$nx|$ls"
  }
  exit 0
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# one glance row per mission found now; the count is fixed for the life of the process
$missionIds = @(Get-Missions | ForEach-Object { $_.Id })
$nM = $missionIds.Count
$missionRowDefs = ''
$missionXaml = ''
for ($i = 0; $i -lt $nM; $i++) {
  $r = 3 + $i
  $missionRowDefs += '<RowDefinition Height="30"/>'
  $span = if ($i -eq 0) { 2 } else { 4 }
  $missionXaml += "    <Ellipse Grid.Row=`"$r`" Grid.Column=`"0`" Name=`"dotMission_$i`" Width=`"10`" Height=`"10`" Fill=`"#666`"/>`n"
  $missionXaml += "    <TextBlock Grid.Row=`"$r`" Grid.Column=`"1`" Grid.ColumnSpan=`"$span`" Name=`"txtMission_$i`" Text=`"...`" Foreground=`"#bbb`" VerticalAlignment=`"Center`" FontSize=`"11`" TextWrapping=`"Wrap`"/>`n"
  if ($i -eq 0) { $missionXaml += "    <Button Grid.Row=`"$r`" Grid.Column=`"3`" Name=`"btnMissions`" Content=`"Missions...`" Height=`"24`" Margin=`"4`" FontSize=`"11`"/>`n" }
}
$noteRow = 3 + $nM
$winHeight = 195 + 30 * $nM

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CynCo" Width="420" Height="$winHeight" ResizeMode="CanMinimize" Topmost="False" ShowInTaskbar="True" WindowStyle="SingleBorderWindow"
        WindowStartupLocation="Manual" Left="40" Top="40" Background="#1e1e24" FontFamily="Segoe UI" FontSize="13">
  <Grid Margin="10">
    <Grid.RowDefinitions><RowDefinition Height="34"/><RowDefinition Height="34"/><RowDefinition/>$missionRowDefs<RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Grid.ColumnDefinitions><ColumnDefinition Width="22"/><ColumnDefinition Width="100"/><ColumnDefinition Width="*"/><ColumnDefinition Width="70"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <Ellipse Grid.Row="0" Grid.Column="0" Name="dotCynco" Width="12" Height="12" Fill="#666"/>
    <TextBlock Grid.Row="0" Grid.Column="1" Text="CynCo" Foreground="#eee" VerticalAlignment="Center" FontWeight="SemiBold"/>
    <TextBlock Grid.Row="0" Grid.Column="2" Name="txtCynco" Text="..." Foreground="#bbb" VerticalAlignment="Center"/>
    <Button Grid.Row="0" Grid.Column="3" Name="btnCynco" Content="..." Height="26" Margin="4"/>
    <Ellipse Grid.Row="1" Grid.Column="0" Name="dotFantasy" Width="12" Height="12" Fill="#666"/>
    <TextBlock Grid.Row="1" Grid.Column="1" Text="Fantasyman" Foreground="#eee" VerticalAlignment="Center" FontWeight="SemiBold"/>
    <TextBlock Grid.Row="1" Grid.Column="2" Name="txtFantasy" Text="..." Foreground="#bbb" VerticalAlignment="Center"/>
    <Button Grid.Row="1" Grid.Column="3" Name="btnFantasy" Content="..." Height="26" Margin="4"/>
    <Ellipse Grid.Row="2" Grid.Column="0" Name="dotGpu" Width="12" Height="12" Fill="#666"/>
    <TextBlock Grid.Row="2" Grid.Column="1" Text="GPU" Foreground="#eee" VerticalAlignment="Center" FontWeight="SemiBold"/>
    <TextBlock Grid.Row="2" Grid.Column="2" Name="txtGpu" Text="..." Foreground="#bbb" VerticalAlignment="Center" FontSize="12" TextWrapping="Wrap"/>
    <Button Grid.Row="2" Grid.Column="3" Name="btnGpu" Content="-" Height="26" Margin="4" IsEnabled="False"/>
    <Button Grid.Row="2" Grid.Column="4" Name="btnStop" Content="Stop" Height="26" Width="54" Margin="0,4,4,4" Visibility="Collapsed"/>
$missionXaml    <TextBlock Grid.Row="$noteRow" Grid.Column="0" Grid.ColumnSpan="5" Name="txtNote" Text="" Foreground="#8a8" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'dotCynco','txtCynco','btnCynco','dotFantasy','txtFantasy','btnFantasy','dotGpu','txtGpu','btnGpu','btnStop','txtNote') { $ui[$n] = $win.FindName($n) }
$ui.btnMissions = $win.FindName('btnMissions')   # $null when there are no missions

$script:state = @{ engine = $null; oneShot = $null; fantasy = @(); gpu = $null }

function Refresh {
  $procs = Get-Procs
  $script:state.engine  = Get-EngineProc $procs
  $script:state.oneShot = Get-OneShotProc $procs
  $script:state.fantasy = Get-FantasyState $procs
  $ts = Get-TailscaleUp

  $local  = Test-Http "http://127.0.0.1:$dashPort/"
  $remote = $false
  if ($tsHost -and $local) { $remote = Test-Http "http://$tsHost`:$dashPort/" }
  if ($local) {
    $ui.dotCynco.Fill = if ($remote) { '#3fb950' } else { '#d29922' }
    $model = Get-ModelState
    $base = if ($remote) { 'on - remote ok' } elseif ($tsHost) { 'on - remote NOT reachable' } else { 'on - local only' }
    $ui.txtCynco.Text = if ($model) { "$base - model $model" } else { $base }
    $ui.btnCynco.Content = 'Stop'
  } else {
    $ui.dotCynco.Fill = '#666'
    $ui.txtCynco.Text = if ($script:state.engine) { 'starting...' } else { 'off' }
    $ui.btnCynco.Content = if ($script:state.engine) { 'Stop' } else { 'Start' }
  }

  $f = $script:state.fantasy
  $ntfyRemote = Test-Tcp '100.110.117.10' 8090   # ntfy runs on the doorman (slice 6)
  if ($f.Count -eq 2) {
    $ui.dotFantasy.Fill = if ($ts -and $ntfyRemote) { '#3fb950' } else { '#d29922' }
    $ui.txtFantasy.Text = if ($ts -and $ntfyRemote) { 'on - phone ok' } elseif (-not $ts) { 'on - Tailscale down' } else { 'on - ntfy not listening' }
    $ui.btnFantasy.Content = 'Stop'
  } elseif ($f.Count -gt 0) {
    $ui.dotFantasy.Fill = '#d29922'
    $ui.txtFantasy.Text = "partial: $($f -join ', ')"
    $ui.btnFantasy.Content = 'Start'
  } else {
    $ui.dotFantasy.Fill = '#666'
    $ui.txtFantasy.Text = 'off'
    $ui.btnFantasy.Content = 'Start'
  }

  $g = Get-GpuState $script:state.oneShot
  $script:state.gpu = $g
  $ui.dotGpu.Fill = $g.Dot
  $ui.txtGpu.Text = $g.Text
  $ui.btnGpu.Content = $g.Button
  $ui.btnGpu.IsEnabled = ($g.Button -ne '-')
  $ui.btnStop.Visibility = if ($g.Stop) { 'Visible' } else { 'Collapsed' }

  $note = "checked $(Get-Date -Format 'HH:mm:ss')"
  if ($script:state.oneShot) {
    # taskRunner.ts names the file task-<triggerId>-<stamp>.json
    $m = [regex]::Match($script:state.oneShot.CommandLine, 'task-(.+)-\d[^\\/]*\.json'); $name = if ($m.Success) { $m.Groups[1].Value } else { 'a task' }
    $note = "daemon is running $name on the GPU - $note"
  }
  $ui.txtNote.Text = $note

  $ms = @(Get-Missions)
  for ($i = 0; $i -lt $nM; $i++) {
    $m = $ms | Where-Object { $_.Id -eq $missionIds[$i] } | Select-Object -First 1
    $row = if ($m) { Get-MissionRowText $m } else { @{ Dot = '#666'; Text = "$($missionIds[$i]): no passes yet" } }
    $win.FindName("dotMission_$i").Fill = $row.Dot
    $win.FindName("txtMission_$i").Text = $row.Text
  }
}

$ui.btnCynco.Add_Click({
  # The headless engine is the logon task "CynCo headless engine" (scripts\run-headless-engine.cmd,
  # lazy model); cynco-services.ps1 owns start/stop/register so the widget and the command line agree.
  $action = if ($script:state.engine) { 'stop' } else { 'start' }
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $services $action engine 2>&1
  $ui.txtNote.Text = ($out -join ' - ')
  Start-Sleep -Milliseconds 800; Refresh
})
$ui.btnFantasy.Add_Click({
  $action = if ($script:state.fantasy.Count -eq 2) { 'stop' } else { 'start' }
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $services $action 2>&1
  $ui.txtNote.Text = ($out -join ' - ')
  Start-Sleep -Milliseconds 800; Refresh
})
$ui.btnGpu.Add_Click({
  $g = $script:state.gpu
  if (-not $g -or $g.Button -eq '-') { return }
  try {
    if ($g.Button -eq 'Pause') {
      Write-DaemonControl $true
      $ui.txtNote.Text = 'pause asked: the daemon kills the running pass (freeing the GPU) and fires nothing until Resume...'
    } elseif ($g.Button -eq 'Hold') {
      Write-DaemonControl $true
      $ui.txtNote.Text = 'hold asked: the GPU stays yours - the daemon starts no pass until Release (missed passes fire late or skip)...'
    } elseif ($g.Button -eq 'Release') {
      Write-DaemonControl $false
      $ui.txtNote.Text = 'released: the daemon goes back to its schedule...'
    } else {
      Write-DaemonControl $false
      $ui.txtNote.Text = 'resume asked: the daemon relaunches the interrupted pass from its journal...'
    }
  } catch { $ui.txtNote.Text = "could not write $ControlFile - $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 800; Refresh
})
$ui.btnStop.Add_Click({
  $g = $script:state.gpu
  if (-not $g -or -not $g.Pid) { return }
  # /T takes the whole tree (bun + llama-server); the daemon records the run as failed and the trigger fires again on its next schedule
  $out = & taskkill /F /T /PID $g.Pid 2>&1
  $ui.txtNote.Text = "stopped $($g.Mode) pass pid $($g.Pid): $(($out -join ' ') -replace '\s+', ' ')"
  Start-Sleep -Milliseconds 800; Refresh
})

if ($ui.btnMissions) {
  $ui.btnMissions.Add_Click({
    if (Test-Http "http://127.0.0.1:$dashPort/") { Start-Process "http://127.0.0.1:$dashPort/#missions" }
    else { $ui.txtNote.Text = 'dashboard is off - start CynCo first' }
  })
}

# remember where the window was left: written from the timer tick (and on close) when it moved
$script:savedPos = $null
function Save-PosIfMoved {
  if ($win.WindowState -ne 'Normal') { return }   # a minimised window reports -32000
  $cur = "$([math]::Round($win.Left)),$([math]::Round($win.Top))"
  if ($cur -eq $script:savedPos) { return }
  try { Save-WidgetPos $win.Left $win.Top; $script:savedPos = $cur } catch {}
}
$pos = Get-WidgetPos
if ($pos) { $win.Left = $pos.Left; $win.Top = $pos.Top; $script:savedPos = "$([math]::Round($pos.Left)),$([math]::Round($pos.Top))" }

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(10)
$timer.Add_Tick({ Refresh; Save-PosIfMoved })
$win.Add_Loaded({ Refresh; $timer.Start() })
$win.Add_Closed({ $timer.Stop(); Save-PosIfMoved })
[void]$win.ShowDialog()
