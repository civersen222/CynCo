# CynCo background services on this PC: the liveness daemon, the ntfy server and
# the dynasty approval listener. Each is a Task Scheduler task that starts at
# logon; this script is the one place to see whether they are actually running,
# and to start or stop them without hunting through Task Scheduler.
#
#   scripts\cynco-services.ps1            status (default)
#   scripts\cynco-services.ps1 start      start every stopped service
#   scripts\cynco-services.ps1 stop       stop every running service
#   scripts\cynco-services.ps1 start ntfy start/stop one by its short name
#
# Status reads the task's own state (Running/Ready), the process behind it when
# it can be matched by command line, and the last line of its log.
param(
  [ValidateSet('status', 'start', 'stop')] [string] $Action = 'status',
  [string] $Only = ''
)

$services = @(
  @{ Name = 'daemon';   Task = 'CynCo liveness daemon';     Match = 'engine\\daemon\\main';   Log = "$env:USERPROFILE\.cynco\daemon.log" },
  @{ Name = 'ntfy';     Task = 'Dynasty ntfy';              Match = 'ntfy\.exe';             Log = 'C:\Users\civer\ntfy\ntfy.log' },
  @{ Name = 'listener'; Task = 'Dynasty approval listener'; Match = 'approval_listener\.py'; Log = '' }
)
if ($Only) { $services = $services | Where-Object { $_.Name -eq $Only }; if (-not $services) { Write-Error "no service named '$Only' (daemon, ntfy, listener)"; exit 2 } }

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }

foreach ($s in $services) {
  $task = Get-ScheduledTask -TaskName $s.Task -ErrorAction SilentlyContinue
  $proc = $procs | Where-Object { $_.CommandLine -match $s.Match } | Select-Object -First 1
  switch ($Action) {
    'start' {
      if ($proc) { Write-Output "$($s.Name): already running (pid $($proc.ProcessId))"; break }
      if (-not $task) { Write-Output "$($s.Name): task '$($s.Task)' not registered"; break }
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
