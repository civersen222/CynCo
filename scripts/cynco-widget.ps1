# CynCo desk widget: a small always-on-top window that says whether CynCo (the
# interactive engine + dashboard) and Fantasyman (the liveness daemon, ntfy and
# the dynasty approval listener) are running and reachable from the phone, with
# one button each to start or stop them. Launch with scripts\cynco-widget.cmd
# (WPF needs an STA PowerShell).
#
#   CynCo ON      = the dashboard answers on 127.0.0.1:<port>
#   CynCo remote  = the dashboard also answers on the Tailscale address
#   Fantasyman ON = daemon + ntfy + listener all running (cynco-services.ps1)
#   Fantasyman remote = Tailscale is up and ntfy listens on its address
#
# Starting CynCo while a daemon one-shot is running is refused: a new engine
# kills whatever llama-server answers on the model port as "stale" (F182).
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$repo      = 'C:\Users\civer\localcode'
$services  = Join-Path $PSScriptRoot 'cynco-services.ps1'
$engineLog = Join-Path $env:USERPROFILE '.cynco\engine-widget.log'
$wsPort    = if ($env:LOCALCODE_WS_PORT) { [int]$env:LOCALCODE_WS_PORT } else { 9160 }
$dashPort  = $wsPort + 1
$hosts     = ($env:LOCALCODE_DASHBOARD_HOST -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $hosts) { $hosts = @('127.0.0.1') }
$tsHost    = $hosts | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne 'localhost' } | Select-Object -First 1

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
  $procs | Where-Object { $_.CommandLine -match 'engine[\\/]main\.ts' -and $_.CommandLine -match '--run-task' } | Select-Object -First 1
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
  if ($procs | Where-Object { $_.CommandLine -match 'ntfy\.exe' })                               { $up += 'ntfy' }
  if ($procs | Where-Object { $_.CommandLine -match 'approval_listener\.py' })                    { $up += 'listener' }
  return $up
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CynCo" Width="340" Height="150" ResizeMode="NoResize" Topmost="True"
        WindowStartupLocation="Manual" Left="40" Top="40" Background="#1e1e24" FontFamily="Segoe UI" FontSize="13">
  <Grid Margin="10">
    <Grid.RowDefinitions><RowDefinition/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Grid.ColumnDefinitions><ColumnDefinition Width="22"/><ColumnDefinition Width="100"/><ColumnDefinition Width="*"/><ColumnDefinition Width="70"/></Grid.ColumnDefinitions>
    <Ellipse Grid.Row="0" Grid.Column="0" Name="dotCynco" Width="12" Height="12" Fill="#666"/>
    <TextBlock Grid.Row="0" Grid.Column="1" Text="CynCo" Foreground="#eee" VerticalAlignment="Center" FontWeight="SemiBold"/>
    <TextBlock Grid.Row="0" Grid.Column="2" Name="txtCynco" Text="…" Foreground="#bbb" VerticalAlignment="Center"/>
    <Button Grid.Row="0" Grid.Column="3" Name="btnCynco" Content="…" Height="26" Margin="4"/>
    <Ellipse Grid.Row="1" Grid.Column="0" Name="dotFantasy" Width="12" Height="12" Fill="#666"/>
    <TextBlock Grid.Row="1" Grid.Column="1" Text="Fantasyman" Foreground="#eee" VerticalAlignment="Center" FontWeight="SemiBold"/>
    <TextBlock Grid.Row="1" Grid.Column="2" Name="txtFantasy" Text="…" Foreground="#bbb" VerticalAlignment="Center"/>
    <Button Grid.Row="1" Grid.Column="3" Name="btnFantasy" Content="…" Height="26" Margin="4"/>
    <TextBlock Grid.Row="2" Grid.Column="0" Grid.ColumnSpan="4" Name="txtNote" Text="" Foreground="#8a8" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'dotCynco','txtCynco','btnCynco','dotFantasy','txtFantasy','btnFantasy','txtNote') { $ui[$n] = $win.FindName($n) }

$script:state = @{ engine = $null; oneShot = $null; fantasy = @() }

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
    $ui.txtCynco.Text = (if ($remote) { 'on - remote ok' } elseif ($tsHost) { 'on - remote NOT reachable' } else { 'on - local only' }) + (if ($model) { " - model $model" } else { '' })
    $ui.btnCynco.Content = 'Stop'
  } else {
    $ui.dotCynco.Fill = '#666'
    $ui.txtCynco.Text = if ($script:state.engine) { 'starting…' } else { 'off' }
    $ui.btnCynco.Content = if ($script:state.engine) { 'Stop' } else { 'Start' }
  }

  $f = $script:state.fantasy
  $ntfyRemote = $tsHost -and (Test-Tcp $tsHost 8090)
  if ($f.Count -eq 3) {
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
  $action = if ($script:state.fantasy.Count -eq 3) { 'stop' } else { 'start' }
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $services $action 2>&1
  $ui.txtNote.Text = ($out -join ' - ')
  Start-Sleep -Milliseconds 800; Refresh
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(10)
$timer.Add_Tick({ Refresh })
$win.Add_Loaded({ Refresh; $timer.Start() })
$win.Add_Closed({ $timer.Stop() })
[void]$win.ShowDialog()
