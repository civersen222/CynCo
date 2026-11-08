# CynCo background services on this PC: the headless phone engine, the liveness daemon,
# the ntfy server and the dynasty approval listener. Each is a Task Scheduler task that
# starts at logon; this script is the one place to see whether they are actually running,
# and to start, stop or register them without hunting through Task Scheduler.
#
#   scripts\cynco-services.ps1                 status (default)
#   scripts\cynco-services.ps1 start           start every stopped service
#   scripts\cynco-services.ps1 stop            stop every running service
#   scripts\cynco-services.ps1 start engine    start/stop one by its short name
#   scripts\cynco-services.ps1 register engine create the logon task when it is missing (engine only;
#                                              the dynasty tasks are owned by fantasyman\dynasty\ops)
#
# Status reads the task's own state (Running/Ready), the process behind it when
# it can be matched by command line, and the last line of its log.
param(
  [ValidateSet('status', 'start', 'stop', 'register')] [string] $Action = 'status',
  [string] $Only = ''
)

$repo = 'C:\Users\civer\localcode'
$services = @(
  @{ Name = 'engine';   Task = 'CynCo headless engine';     Match = 'engine\\main\.ts(?!.*--run-task)'; Log = "$env:USERPROFILE\.cynco\engine-headless.log"; Register = @{ Action = (Join-Path $repo 'scripts\run-headless-engine.cmd'); Description = 'CynCo headless phone engine: dashboard behind the doorman, cold GPU until a message needs the model' } },
  @{ Name = 'daemon';   Task = 'CynCo liveness daemon';     Match = 'engine\\daemon\\main';   Log = "$env:USERPROFILE\.cynco\daemon.log" },
  @{ Name = 'ntfy';     Task = 'Dynasty ntfy';              Match = 'ntfy\.exe';             Log = 'C:\Users\civer\ntfy\ntfy.log' },
  @{ Name = 'listener'; Task = 'Dynasty approval listener'; Match = 'approval_listener\.py'; Log = '' }
)
if ($Only) { $services = $services | Where-Object { $_.Name -eq $Only }; if (-not $services) { Write-Error "no service named '$Only' (engine, daemon, ntfy, listener)"; exit 2 } }

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }

foreach ($s in $services) {
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
