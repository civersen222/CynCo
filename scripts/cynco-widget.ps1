# CynCo desk widget: a small always-on-top window that says whether CynCo (the
# interactive engine + dashboard) and Fantasyman (the liveness daemon, ntfy and
# the dynasty approval listener) are running and reachable from the phone, with
# one button each to start or stop them, plus a GPU row that says who holds the
# RTX 5090 and lets the owner pause/resume or stop the daemon's running pass.
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
# Pause/resume speak to the daemon through $env:USERPROFILE\.cynco\daemon-control.json
# ({"paused": true|false, "requestedAt": "<ISO 8601 UTC>"}, written atomically).
# Stop is taskkill /F /T on the one-shot; its llama-server dies with it.
#
# Starting CynCo while a daemon one-shot is running is refused: a new engine
# kills whatever llama-server answers on the model port as "stale" (F182).
#
#   -Probe        compute the GPU row once, print "<dot>|<text>|<button>", exit
#   -MissionsDir  where the missions live (tests point it at a copy)
#   -ControlFile  the daemon control file (tests point it at a temp path)
#
# Keep every string literal ASCII: PS 5.1 reads this file as ANSI.
param(
  [switch] $Probe,
  [string] $MissionsDir = (Join-Path $env:USERPROFILE '.cynco\missions'),
  [string] $ControlFile = (Join-Path $env:USERPROFILE '.cynco\daemon-control.json')
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
  # one record per mission folder: the trigger ids mission.json declares and the parsed state.json
  if (-not (Test-Path -LiteralPath $MissionsDir)) { return @() }
  $out = @()
  foreach ($d in Get-ChildItem -LiteralPath $MissionsDir -Directory) {
    $m = Read-Json (Join-Path $d.FullName 'mission.json')
    if (-not $m) { continue }
    $ids = @($m.triggers | ForEach-Object { $_.id } | Where-Object { $_ })
    $out += [pscustomobject]@{ Id = $d.Name; Triggers = $ids; State = (Read-Json (Join-Path $d.FullName 'state.json')) }
  }
  return $out
}
function Get-NextFire($missions) {
  # the earliest nextFire over both missions, counting only ids mission.json still declares
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
  $json = '{"paused": ' + $flag + ', "requestedAt": "' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + '"}'
  [IO.File]::WriteAllText($tmp, $json)   # UTF-8 without BOM
  Move-Item -LiteralPath $tmp -Destination $ControlFile -Force
}

if ($Probe) {
  $s = Get-GpuState (Get-OneShotProc (Get-Procs))
  Write-Output "$($s.Dot)|$($s.Text)|$($s.Button)"
  exit 0
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CynCo" Width="420" Height="195" ResizeMode="NoResize" Topmost="True"
        WindowStartupLocation="Manual" Left="40" Top="40" Background="#1e1e24" FontFamily="Segoe UI" FontSize="13">
  <Grid Margin="10">
    <Grid.RowDefinitions><RowDefinition Height="34"/><RowDefinition Height="34"/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
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
    <TextBlock Grid.Row="3" Grid.Column="0" Grid.ColumnSpan="5" Name="txtNote" Text="" Foreground="#8a8" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'dotCynco','txtCynco','btnCynco','dotFantasy','txtFantasy','btnFantasy','dotGpu','txtGpu','btnGpu','btnStop','txtNote') { $ui[$n] = $win.FindName($n) }

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

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(10)
$timer.Add_Tick({ Refresh })
$win.Add_Loaded({ Refresh; $timer.Start() })
$win.Add_Closed({ $timer.Stop() })
[void]$win.ShowDialog()
