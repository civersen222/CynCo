# Keeps Windows from sleeping for exactly as long as this process lives.
# Spawned by engine/power/awake.ts when the first activity opens (a turn, a one-shot,
# a model request) and killed when the last one ends. It also exits on its own when
# the parent process is gone, so a crashed engine or daemon never leaves the PC awake.
# Shows in `powercfg /requests` (elevated) as a SYSTEM request from powershell.exe.
param([Parameter(Mandatory = $true)][int] $ParentPid)

Add-Type -Namespace CynCo -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001
[void][CynCo.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

while ($true) {
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
}
[void][CynCo.Power]::SetThreadExecutionState($ES_CONTINUOUS)
