# CynCo background services on this PC: the headless phone engine, the embedding server, the liveness daemon,
# the box reporter (it tells the watcher on the doorman what this PC is doing) and the dynasty approval listener; plus ntfy, which runs on the doorman and is shown as reachable or not. Each is a Task Scheduler task that
# starts at logon; this script is the one place to see whether they are actually running,
# and to start, stop or register them without hunting through Task Scheduler.
#
#   scripts\cynco-services.ps1                 status (default)
#   scripts\cynco-services.ps1 start           start every stopped service (under the integrity latch the daemon is not started: bun scripts\cynco-guard.mjs status)
#   scripts\cynco-services.ps1 start -WhatIf   say what start would do, and start nothing
#   scripts\cynco-services.ps1 stop            stop every running service
#   scripts\cynco-services.ps1 start engine    start/stop one by its short name
#   scripts\cynco-services.ps1 register engine create the logon task when it is missing (engine, embed, daemon, watch;
#                                              the dynasty tasks are owned by fantasyman\dynasty\ops)
#
# Status reads the task's own state (Running/Ready), the process behind it when
# it can be matched by command line, and the last line of its log.
param(
  [ValidateSet('status', 'start', 'stop', 'register')] [string] $Action = 'status',
  [string] $Only = '',
  # A process never to match: the desk engine passes its own pid, since it is a `bun engine\main.ts` too
  # (engine/power/siblingEngine.ts) and must not read itself as the phone engine or stop itself.
  [int] $ExcludePid = 0,
  # Exercise the start branch against the task list without starting a task (used by the test of the
  # integrity latch refusal). start only.
  [switch] $WhatIf
)

$repo = 'C:\Users\civer\localcode'
$services = @(
  @{ Name = 'engine';   Task = 'CynCo headless engine';     Match = 'engine\\main\.ts(?!.*--run-task)'; Log = "$env:USERPROFILE\.cynco\engine-headless.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-headless-engine.cmd'); Description = 'CynCo headless phone engine: dashboard behind the doorman, cold GPU until a message needs the model' } },
  @{ Name = 'embed';    Task = 'CynCo embed server';        Match = 'llama-server.*--embeddings'; Log = "$env:USERPROFILE\.cynco\embed-server.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-embed-server.cmd'); Description = 'CynCo embedding server: llama-server --embeddings on 127.0.0.1:9165 (nomic-embed-text, CPU) for every engine''s project and code index' } },
  @{ Name = 'daemon';   Task = 'CynCo liveness daemon';     Match = 'engine\\daemon\\main';   Log = "$env:USERPROFILE\.cynco\daemon.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-daemon.cmd'); Description = 'CynCo liveness daemon: triggers, one-shots, phone commands, and the hourly page for an oversized service log' } },
  @{ Name = 'watch';    Task = 'CynCo box reporter';        Match = 'engine\\power\\reporter\\main'; Log = "$env:USERPROFILE\.cynco\box-reporter.log"; Goodbye = 'engine\power\reporter\main.ts'; Register = @{ Action = (Join-Path $repo 'scripts\run-box-reporter.cmd'); Description = 'CynCo box reporter: pushes this PC''s state (awake and asleep, GPUs, model, services, jobs) to the watcher on the doorman; listens on nothing, changes nothing' } },
  @{ Name = 'ntfy';     Remote = '100.110.117.10'; Port = 8090; Note = 'on the doorman (docker compose, /opt/doorman/ntfy)' },
  @{ Name = 'listener'; Task = 'Dynasty approval listener'; Match = 'approval_listener\.py'; Log = '' }
)
if ($Only) { $services = $services | Where-Object { $_.Name -eq $Only }; if (-not $services) { Write-Error "no service named '$Only' (engine, embed, daemon, watch, ntfy, listener)"; exit 2 } }

if ($WhatIf -and $Action -ne 'start') { Write-Error '-WhatIf applies to start only'; exit 2 }
# F242: under the integrity latch (or with no usable guard folder) the daemon is not started. Every
# other service starts, with one warning line: the dashboard must be reachable exactly then.
$guardRefusal = $null
$daemonRefused = $false
# The plain status shows the integrity latch too (review of wave 5): with the daemon down, nothing else
# on this PC says that a latch stands.
if ($Action -eq 'start' -or $Action -eq 'status') {
  $guardLine = ''; $guardExit = 3
  try {
    # Collect first, read the exit code afterwards: after a pipe that closes early $LASTEXITCODE is -1.
    $out = & bun --no-install (Join-Path $PSScriptRoot 'cynco-guard.mjs') status --quiet 2>&1; $guardExit = $LASTEXITCODE
    $guardLine = ($out | Select-Object -First 1)
  } catch { $guardLine = "the guard check did not run ($($_.Exception.Message))" }
  if ($Action -eq 'status') {
    $shown = if ($guardLine) { "$guardLine" } else { "the guard check did not answer (exit $guardExit)" }
    Write-Output ("{0,-9} {1}" -f 'integrity', $shown)
  } elseif ($guardExit -ne 0) {
    $guardRefusal = "$guardLine"
    if (-not $guardRefusal) { $guardRefusal = "the guard check did not answer (exit $guardExit)" }
    Write-Output "warning: $guardRefusal"
  }
}

# The last non-empty line of a file, read from its last 4 KiB (shared read: the service keeps appending). '' when unreadable.
function Get-LastLine([string]$path) {
  try {
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
      $n = [int][Math]::Min(4096, $fs.Length)
      [void]$fs.Seek(-$n, [IO.SeekOrigin]::End)
      $buf = New-Object byte[] $n
      $got = $fs.Read($buf, 0, $n)
      $lines = [Text.Encoding]::UTF8.GetString($buf, 0, $got) -split "`r?`n" | Where-Object { $_.Trim() -ne '' }
      if ($lines) { return @($lines)[-1] } else { return '' }
    } finally { $fs.Dispose() }
  } catch { return '' }
}

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $ExcludePid }

foreach ($s in $services) {
  if ($s.Remote) {
    # -WhatIf touches nothing, the network included.
    if ($WhatIf) { Write-Output "$($s.Name): runs on the doorman; not asked (-WhatIf)"; continue }
    # A service that lives on the doorman: no task here, only reachability over the tailnet.
    $up = $false
    try { $c = New-Object Net.Sockets.TcpClient; $up = $c.ConnectAsync($s.Remote, $s.Port).Wait(1500) -and $c.Connected; $c.Close() } catch {}
    if ($Action -eq 'status') { Write-Output ("{0,-9} {1,-22} {2}" -f $s.Name, $(if ($up) { "UP on $($s.Remote):$($s.Port)" } else { 'DOWN (doorman)' }), $s.Note) }
    else { Write-Output "$($s.Name): runs on the doorman - use scripts/doorman/deploy.sh (or ssh cynco@$($s.Remote) and docker compose in /opt/doorman/ntfy)" }
    continue
  }
  $task = Get-ScheduledTask -TaskName $s.Task -ErrorAction SilentlyContinue
  $proc = $procs | Where-Object { $_.Name -eq 'bun.exe' -or $_.Name -notmatch 'bun' } | Where-Object { $_.CommandLine -match $s.Match } | Select-Object -First 1
  switch ($Action) {
    'register' {
      if (-not $s.Register) { Write-Output "$($s.Name): registration is owned elsewhere (not this script)"; break }
      if ($task) { Write-Output "$($s.Name): task '$($s.Task)' already registered"; break }
      $act = New-ScheduledTaskAction -Execute $s.Register.Action
      $trig = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
      Register-ScheduledTask -TaskName $s.Task -Action $act -Trigger $trig -Settings $set -Description $s.Register.Description | Out-Null
      Write-Output "$($s.Name): registered '$($s.Task)' (at logon)"
    }
    'start' {
      if ($guardRefusal -and $s.Name -eq 'daemon') { Write-Output "daemon: start REFUSED: integrity: $guardRefusal"; $daemonRefused = $true; break }
      if ($proc) { Write-Output "$($s.Name): already running (pid $($proc.ProcessId))"; break }
      if (-not $task) { Write-Output "$($s.Name): task '$($s.Task)' not registered" + $(if ($s.Register) { " - run: cynco-services.ps1 register $($s.Name)" } else { '' }); break }
      if ($WhatIf) { Write-Output "$($s.Name): would start (-WhatIf)"; break }
      Start-ScheduledTask -TaskName $s.Task
      Write-Output "$($s.Name): started"
    }
    'stop' {
      if ($s.Goodbye -and $proc) {
        # Windows ends a task's process outright. A service that can say it is stopping is asked to
        # first: the box reporter tells the watcher, which then shows this box as not watched and
        # not as gone silent (F232). No answer in ten seconds, and it is stopped anyway.
        Push-Location $repo
        try { & bun --no-install $s.Goodbye --stop | ForEach-Object { Write-Output "$($s.Name): $_" } }
        catch { Write-Output "$($s.Name): could not ask it to stop first ($($_.Exception.Message)); stopping it anyway" }
        finally { Pop-Location }
      }
      if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $s.Task }
      if ($proc) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
      if ($task -or $proc) { Write-Output "$($s.Name): stopped" } else { Write-Output "$($s.Name): not running" }
    }
    default {
      $state = if (-not $task) { 'NOT REGISTERED' } elseif ($proc) { "RUNNING (pid $($proc.ProcessId))" } else { 'STOPPED' }
      $last = ''
      # Wave 15 (NOW.md:94): the log's size, so a log growing toward its cap is seen before the daily page.
      $size = ''
      if ($s.Log) {
        $item = Get-Item -LiteralPath $s.Log -ErrorAction SilentlyContinue
        # One form on every Windows (wave 15b): a decimal point and no group separator, whatever the culture.
        $size = if ($item) { '[log ' + ([double]($item.Length / 1MB)).ToString('F1', [System.Globalization.CultureInfo]::InvariantCulture) + ' MiB] ' } else { '[no log] ' }
      }
      # The last line from the last 4 KiB only: Get-Content -Tail reads a log with no line break back to its start
      # (measured 2026-11-24: over 90 s for 3 MiB of one line), and a service log can be gigabytes.
      if ($s.Log -and (Test-Path $s.Log)) { $last = Get-LastLine $s.Log; if ($last.Length -gt 110) { $last = $last.Substring(0, 110) + '...' } }
      Write-Output ("{0,-9} {1,-22} {2}{3}" -f $s.Name, $state, $size, $last)
      # Wave 15 (NOW.md:91): the rotation's own refusal or failure line, which the launcher writes beside the log.
      if ($s.Log) {
        $rot = $s.Log -replace '\.log$', '.rotate.log'
        $rl = if (Test-Path -LiteralPath $rot) { Get-LastLine $rot } else { $null }
        if ($rl) { Write-Output ("{0,-9} rotation: {1}" -f '', $rl) }
      }
    }
  }
}
if ($daemonRefused) { exit 3 }
