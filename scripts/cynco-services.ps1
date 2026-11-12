# CynCo background services on this PC: the headless phone engine, the embedding server, the liveness daemon,
# the box reporter (it tells the watcher on the doorman what this PC is doing) and the dynasty approval listener; plus ntfy, which runs on the doorman and is shown as reachable or not. Each is a Task Scheduler task that
# starts at logon; this script is the one place to see whether they are actually running,
# and to start, stop or register them without hunting through Task Scheduler.
#
#   scripts\cynco-services.ps1                 status (default)
#   scripts\cynco-services.ps1 start           start every stopped service
#   scripts\cynco-services.ps1 stop            stop every running service
#   scripts\cynco-services.ps1 start engine    start/stop one by its short name
#   scripts\cynco-services.ps1 register engine create the logon task when it is missing (engine, embed, watch;
#                                              the dynasty tasks are owned by fantasyman\dynasty\ops)
#
# Status reads the task's own state (Running/Ready), the process behind it when
# it can be matched by command line, and the last line of its log.
param(
  [ValidateSet('status', 'start', 'stop', 'register')] [string] $Action = 'status',
  [string] $Only = '',
  # A process never to match: the desk engine passes its own pid, since it is a `bun engine\main.ts` too
  # (engine/power/siblingEngine.ts) and must not read itself as the phone engine or stop itself.
  [int] $ExcludePid = 0
)

$repo = 'C:\Users\civer\localcode'
$services = @(
  @{ Name = 'engine';   Task = 'CynCo headless engine';     Match = 'engine\\main\.ts(?!.*--run-task)'; Log = "$env:USERPROFILE\.cynco\engine-headless.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-headless-engine.cmd'); Description = 'CynCo headless phone engine: dashboard behind the doorman, cold GPU until a message needs the model' } },
  @{ Name = 'embed';    Task = 'CynCo embed server';        Match = 'llama-server.*--embeddings'; Log = "$env:USERPROFILE\.cynco\embed-server.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-embed-server.cmd'); Description = 'CynCo embedding server: llama-server --embeddings on 127.0.0.1:9165 (nomic-embed-text, CPU) for every engine''s project and code index' } },
  @{ Name = 'daemon';   Task = 'CynCo liveness daemon';     Match = 'engine\\daemon\\main';   Log = "$env:USERPROFILE\.cynco\daemon.log" },
  @{ Name = 'watch';    Task = 'CynCo box reporter';        Match = 'engine\\power\\reporter\\main'; Log = "$env:USERPROFILE\.cynco\box-reporter.log"; Goodbye = 'engine\power\reporter\main.ts'; Register = @{ Action = (Join-Path $repo 'scripts\run-box-reporter.cmd'); Description = 'CynCo box reporter: pushes this PC''s state (awake and asleep, GPUs, model, services, jobs) to the watcher on the doorman; listens on nothing, changes nothing' } },
  @{ Name = 'ntfy';     Remote = '100.110.117.10'; Port = 8090; Note = 'on the doorman (docker compose, /opt/doorman/ntfy)' },
  @{ Name = 'listener'; Task = 'Dynasty approval listener'; Match = 'approval_listener\.py'; Log = '' }
)
if ($Only) { $services = $services | Where-Object { $_.Name -eq $Only }; if (-not $services) { Write-Error "no service named '$Only' (engine, embed, daemon, watch, ntfy, listener)"; exit 2 } }

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $ExcludePid }

foreach ($s in $services) {
  if ($s.Remote) {
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
      if ($proc) { Write-Output "$($s.Name): already running (pid $($proc.ProcessId))"; break }
      if (-not $task) { Write-Output "$($s.Name): task '$($s.Task)' not registered" + $(if ($s.Register) { " - run: cynco-services.ps1 register $($s.Name)" } else { '' }); break }
      Start-ScheduledTask -TaskName $s.Task
      Write-Output "$($s.Name): started"
    }
    'stop' {
      if ($s.Goodbye -and $proc) {
        # Windows ends a task's process outright. A service that can say it is stopping is asked to
        # first: the box reporter tells the watcher, which then shows this box as not watched and
        # not as gone silent (F232). No answer in ten seconds, and it is stopped anyway.
        Push-Location $repo
        try { & bun $s.Goodbye --stop | ForEach-Object { Write-Output "$($s.Name): $_" } }
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
      if ($s.Log -and (Test-Path $s.Log)) { $last = (Get-Content $s.Log -Tail 1); if ($last.Length -gt 110) { $last = $last.Substring(0, 110) + '...' } }
      Write-Output ("{0,-9} {1,-22} {2}" -f $s.Name, $state, $last)
    }
  }
}
