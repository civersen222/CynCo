<#
.SYNOPSIS
  One-time setup and standing report for mission containment on a Windows machine.

.DESCRIPTION
  Containment keeps its sandboxes, its guard state and its tool-call audit in three folders outside the
  home folder, and can keep the models outside it too. No run ever creates one of those folders: this
  script does, once. Without -Apply it changes nothing and prints one line per item: ok, TODO, STOP or
  info. With -Apply it may do exactly these things and nothing else:
    - create a missing sandbox, guard or audit folder (the leaf only)
    - create the audit folder's marker file, .cynco-audit
    - set the user variable LOCALCODE_MODELS_DIR (with -ModelsDir)
    - set the user variable LOCALCODE_UNPROTECTED_VOLUMES_OK (with -AcknowledgeVolumes)
    - make or refresh the copy of Git's Unix tools a contained run may start (with -MsysCopy; folder
      -MsysDir, default C:\cynco-msys): usr\bin, etc, dev and tmp of the installed Git copied into it,
      never a link, and a manifest beside them (the SHA-256 of msys-2.0.dll and the file count). A run
      uses it only when its starter has LOCALCODE_CONTAINMENT_MSYS naming it.
  It never deletes or moves, copies nothing but that runtime into that folder, never changes an access
  list or a label, and never looks inside a models folder further than its direct sub-folders. Run it in
  an ordinary, non-elevated PowerShell. The procedure and the meaning of every line: docs/containment-setup.md.

.EXAMPLE
  scripts\cynco-containment-setup.ps1                                    # report only
  scripts\cynco-containment-setup.ps1 -Apply                             # create the missing folders
  scripts\cynco-containment-setup.ps1 -ModelsDir C:\cynco-models -Apply  # after the models were moved there
  scripts\cynco-containment-setup.ps1 -AcknowledgeVolumes X: -Apply      # a volume Windows cannot protect
  scripts\cynco-containment-setup.ps1 -MsysCopy -Apply                   # the copy of Git's Unix tools (again after a Git update)
#>
param(
  [string]$ModelsDir = '',
  [string]$AcknowledgeVolumes = '',
  [switch]$MsysCopy,
  [string]$MsysDir = 'C:\cynco-msys',
  [string]$GitRoot = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
# A text copy of the switch's name; scripts/__tests__/cynco-containment-setup.test.mjs pins it to the engine's.
$SwitchVar = 'LOCALCODE_CONTAINMENT_OFF'
$script:stops = 0      # every STOP line
$script:blocking = 0   # the STOP lines that forbid -Apply

function Say([string]$mark, [string]$text) { Write-Host ("{0,-6} {1}" -f $mark, $text) }
function Stop-Here([string]$text) { $script:stops++; $script:blocking++; Say 'STOP' $text }
function Stop-Daemon([string]$text) { $script:stops++; Say 'STOP' "daemon: $text" }
function Get-UserVar([string]$name) { [Environment]::GetEnvironmentVariable($name, 'User') }
function Get-MachineVar([string]$name) { [Environment]::GetEnvironmentVariable($name, 'Machine') }

function Get-Full([string]$p) {
  $f = [System.IO.Path]::GetFullPath($p)
  if ($f.Length -gt 3) { $f = $f.TrimEnd('\') }
  return $f
}
function Test-Inside([string]$child, [string]$parent) {
  $c = (Get-Full $child).ToLowerInvariant()
  $q = (Get-Full $parent).ToLowerInvariant().TrimEnd('\')
  return ($c -eq $q) -or $c.StartsWith($q + '\')
}
# The first link (junction, symbolic link, mount point) that is the path or one of its existing parents.
function Get-LinkOnPath([string]$p) {
  $cur = Get-Full $p
  while ($cur) {
    if (Test-Path -LiteralPath $cur) {
      $item = Get-Item -LiteralPath $cur -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $cur }
    }
    $next = Split-Path -Path $cur -Parent
    if (-not $next -or $next -eq $cur) { break }
    $cur = $next
  }
  return ''
}
# The integrity label of a path, read from its security descriptor as SDDL (GetNamedSecurityInfo with
# LABEL_SECURITY_INFORMATION, which needs no privilege), never from the words icacls prints, which Windows
# translates (NOW.md:98). Get-Acl cannot be used: it does not read the label. Answers 'low-inheritable' (a
# Low label that the folders under it inherit), 'low', 'not-low' (another label, or none), or $null when
# the descriptor could not be read.
if (-not ('CyncoSetupLabel' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CyncoSetupLabel {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern uint GetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint revision, uint info, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr mem);
  public static string Sddl(string path) {
    IntPtr sd;
    // SE_FILE_OBJECT = 1, LABEL_SECURITY_INFORMATION = 0x10.
    if (GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd) != 0) return null;
    try {
      IntPtr text; uint length;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x10, out text, out length)) return null;
      try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    } finally { LocalFree(sd); }
  }
}
'@
}
function Get-LowLabel([string]$p) {
  $sddl = [CyncoSetupLabel]::Sddl($p)
  if ($null -eq $sddl) { return $null }
  $low = [regex]::Matches($sddl, '\(ML;([A-Z]*);[^;)]*;;;(LW|S-1-16-4096|S-1-16-0)\)')
  if ($low.Count -eq 0) { return 'not-low' }
  foreach ($m in $low) { if ($m.Groups[1].Value -match 'CI') { return 'low-inheritable' } }
  return 'low'
}
# Why a folder cannot hold containment state, as sentence tails; nothing when it can.
function Get-FolderProblems([string]$p) {
  if ($p -notmatch '^[A-Za-z]:\\[^\\]') { return @('is not a full path below a drive letter') }
  $problems = @()
  $full = Get-Full $p
  $drive = New-Object System.IO.DriveInfo ($full.Substring(0, 2))
  if (-not $drive.IsReady) {
    $problems += "is on $($drive.Name), which is not ready"
  } elseif ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
    $problems += "is on $($drive.Name) ($($drive.DriveType), $($drive.DriveFormat)): only a local NTFS volume carries integrity labels"
  }
  if ((Test-Inside $full $env:USERPROFILE) -or (Test-Inside $env:USERPROFILE $full)) {
    $problems += "is inside, or contains, the home folder $env:USERPROFILE"
  }
  $link = Get-LinkOnPath $full
  if ($link) { $problems += "is, or is under, a link ($link)" }
  if (Test-Path -LiteralPath $full) {
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
      $problems += 'exists and is not a folder'
    } else {
      $label = Get-LowLabel $full
      if ($null -eq $label) {
        $problems += 'has an access list that could not be read, so its integrity label is unknown'
      } elseif ($label -ne 'not-low') {
        $problems += 'carries a Low integrity label, so a contained process could write it'
      }
    }
  } else {
    # The folder -Apply makes inherits an inheritable label from its parent.
    $parent = Split-Path -Path $full -Parent
    if ($parent -and (Test-Path -LiteralPath $parent -PathType Container)) {
      $plabel = Get-LowLabel $parent
      if ($null -eq $plabel) {
        $problems += "has a parent ($parent) whose access list could not be read, so the label the new folder would inherit is unknown"
      } elseif ($plabel -eq 'low-inheritable') {
        $problems += "has a parent ($parent) with an inheritable Low integrity label, so the folder -Apply makes would be writable by a contained process"
      }
    }
  }
  return $problems
}
function Get-ModelsProblems([string]$p) {
  $problems = @(Get-FolderProblems $p)
  if ($problems.Count -gt 0) { return $problems }
  if (-not (Test-Path -LiteralPath $p -PathType Container)) { return @('does not exist') }
  $gguf = @(Get-ChildItem -LiteralPath $p -File -Filter '*.gguf' -Force)
  foreach ($sub in @(Get-ChildItem -LiteralPath $p -Directory -Force)) {
    $gguf += @(Get-ChildItem -LiteralPath $sub.FullName -File -Filter '*.gguf' -Force)
  }
  if ($gguf.Count -eq 0) { return @('holds no .gguf file in itself or in a direct sub-folder') }
  return @()
}

# -- The copy of Git's Unix tools (B1, wave 19) ------------------------------------------------------------
# A low process cannot start the installed Git's msys runtime while a normal-privilege one runs; a copy in a
# folder of its own has a shared namespace of its own (measured 2026-11-24). The engine refuses a run whose
# copy is older than the installed Git, so this step is run again after every Git update.
$MsysManifestName = 'cynco-msys.manifest.json'
$MsysParts = @('usr\bin', 'etc', 'dev', 'tmp')
# The installed Git: the root above the first git.exe on PATH (cmd, bin or mingw64\bin), else Program Files.
function Find-GitRoot {
  $cmd = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $candidates = @()
  if ($cmd) {
    $d = Split-Path -Path $cmd.Source -Parent
    $candidates += (Split-Path -Path $d -Parent)
    $candidates += (Split-Path -Path (Split-Path -Path $d -Parent) -Parent)
  }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Git') }
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath (Join-Path $c 'usr\bin\msys-2.0.dll'))) { return $c } }
  return ''
}
function Get-Sha256([string]$p) { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
# 'missing', 'current', 'stale' (made by this script for another Git), or 'foreign' (a folder this script did not make).
function Get-MsysCopyState([string]$gitRoot, [string]$target) {
  if (-not (Test-Path -LiteralPath $target)) { return 'missing' }
  $manifest = Join-Path $target $MsysManifestName
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { return 'missing' }
    return 'foreign'
  }
  $m = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $dll = Join-Path $target 'usr\bin\msys-2.0.dll'
  if (-not (Test-Path -LiteralPath $dll)) { return 'stale' }
  $installed = Get-Sha256 (Join-Path $gitRoot 'usr\bin\msys-2.0.dll')
  if ($m.dllSha256 -ne $installed -or (Get-Sha256 $dll) -ne $installed) { return 'stale' }
  return 'current'
}
# Copy usr\bin, etc, dev and tmp of $gitRoot into $target (never a link: robocopy /XJ; nothing deleted:
# no /MIR or /PURGE), then check what was made and write the manifest. Answers the lines to print;
# the first word of the last line is 'made' or 'STOP'.
function Copy-MsysRuntime([string]$gitRoot, [string]$target) {
  $state = Get-MsysCopyState $gitRoot $target
  if ($state -eq 'foreign') { return @("STOP $target holds files and no $MsysManifestName, so this script did not make it; name another folder with -MsysDir") }
  if ($state -eq 'current') { return @("made $target is current (nothing copied)") }
  if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
  foreach ($part in $MsysParts) {
    $null = & robocopy (Join-Path $gitRoot $part) (Join-Path $target $part) /E /COPY:DAT /DCOPY:DAT /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { return @("STOP robocopy could not copy $part into $target (exit $LASTEXITCODE)") }
  }
  # One walk that never enters a link (Windows PowerShell 5.1's own recursion follows a junction).
  $links = @(); $files = 0
  $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  $stack.Push((New-Object System.IO.DirectoryInfo $target))
  while ($stack.Count -gt 0) {
    foreach ($e in $stack.Pop().EnumerateFileSystemInfos()) {
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $links += $e.FullName; continue }
      if ($e.Attributes -band [System.IO.FileAttributes]::Directory) { $stack.Push($e) } elseif ($e.Name -ne $MsysManifestName) { $files++ }
    }
  }
  if ($links.Count -gt 0) { return @("STOP the copy $target holds a link ($($links[0])); remove the copy yourself and look at the installed Git") }
  $label = Get-LowLabel $target
  if ($label -ne 'not-low') { return @("STOP the copy $target carries a Low integrity label or one that could not be read ($label), so a contained run could change it") }
  $installed = Get-Sha256 (Join-Path $gitRoot 'usr\bin\msys-2.0.dll')
  if ((Get-Sha256 (Join-Path $target 'usr\bin\msys-2.0.dll')) -ne $installed) { return @("STOP the copy's msys-2.0.dll differs from the installed Git's after the copy") }
  $json = (@{ dllSha256 = $installed; files = $files; source = $gitRoot; madeAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress)
  [System.IO.File]::WriteAllText((Join-Path $target $MsysManifestName), $json)
  return @("made $target ($files files, msys-2.0.dll $installed)")
}

# -- 0. Not elevated: the home folder and the user variables must be the owner's ------------------------
$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Here "this PowerShell is elevated. With a separate administrator account its home folder and its user variables are that account's, not yours, so the checks below would compare against the wrong home and -Apply would set the wrong account's variables. Run it in an ordinary PowerShell."
} else {
  Say 'ok' 'this PowerShell is not elevated'
}

# -- 1. The switch that turns a layer off must not exist outside a test ---------------------------------
$before = $script:blocking
foreach ($scope in 'User', 'Machine') {
  $v = [Environment]::GetEnvironmentVariable($SwitchVar, $scope)
  if ($v) {
    Stop-Here "$SwitchVar is set at $($scope.ToLower()) level ($v). It switches a containment layer off and is for the test suite only: every dispatch, daemon task and contained engine refuses while it is set. Remove it (System Properties, Environment Variables), then sign out and in."
  }
}
if ($script:blocking -eq $before) { Say 'ok' "$SwitchVar is not set at user or machine level" }

# -- 2. The three folders no run may create -----------------------------------------------------------
$roots = @(
  @{ Label = 'sandbox root'; Var = 'LOCALCODE_SANDBOX_ROOT'; Default = 'C:\cynco-sandbox' },
  @{ Label = 'guard folder'; Var = 'LOCALCODE_GUARD_DIR';    Default = 'C:\cynco-guard' },
  @{ Label = 'audit folder'; Var = 'LOCALCODE_AUDIT_DIR';    Default = 'C:\cynco-audit' }
)
$toCreate = @()
$marker = ''
$markerNeeded = $false
$kept = @()     # every folder resolved above and below, for the overlap check after section 3
foreach ($r in $roots) {
  $u = Get-UserVar $r.Var
  $m = Get-MachineVar $r.Var
  $path = $r.Default
  $from = 'the built-in default'
  if ($m) { $path = $m; $from = "the machine variable $($r.Var)" }
  if ($u) { $path = $u; $from = "the user variable $($r.Var)" }
  $path = $path -replace '/', '\'
  $problems = @(Get-FolderProblems $path)
  if ($problems.Count -gt 0) {
    foreach ($x in $problems) { Stop-Here "the $($r.Label) $path ($from) $x." }
    continue
  }
  $kept += @{ Label = "the $($r.Label)"; Path = (Get-Full $path) }
  if ($r.Var -eq 'LOCALCODE_GUARD_DIR' -and (Get-Full $path) -ne (Get-Full $r.Default) -and (Test-Path -LiteralPath $r.Default)) {
    Stop-Here "LOCALCODE_GUARD_DIR points at $path and the default $($r.Default) also exists: a process that loses the variable would read the default folder and find no latch there. Keep one guard folder."
  }
  if (Test-Path -LiteralPath $path) {
    Say 'ok' "the $($r.Label) $path exists ($from)"
  } else {
    $parent = Split-Path -Path $path -Parent
    if (-not (Test-Path -LiteralPath $parent)) {
      Stop-Here "the $($r.Label) $path does not exist and neither does its parent $parent. Create the parent yourself; this script creates one folder, never a tree."
      continue
    }
    $toCreate += $path
    Say 'TODO' "the $($r.Label) $path does not exist ($from). -Apply creates it."
  }
  if ($r.Var -eq 'LOCALCODE_AUDIT_DIR') {
    $marker = Join-Path $path '.cynco-audit'
    if (-not (Test-Path -LiteralPath $path)) {
      $markerNeeded = $true
    } elseif (Test-Path -LiteralPath $marker) {
      Say 'ok' "the audit folder carries its marker $marker"
    } elseif (@(Get-ChildItem -LiteralPath $path -Force).Count -gt 0) {
      Stop-Here "the audit folder $path is not empty and has no .cynco-audit marker, so it was not made by this script. Name another folder with LOCALCODE_AUDIT_DIR, or empty this one yourself."
    } else {
      $markerNeeded = $true
      Say 'TODO' "the audit folder $path has no .cynco-audit marker. -Apply writes it."
    }
  }
  if ($r.Var -eq 'LOCALCODE_GUARD_DIR') {
    # Every unattended run is refused without the models hash record; this script does not take it.
    $record = Join-Path $path 'models-hashes.json'
    if (Test-Path -LiteralPath $record) { Say 'ok' "the models hash record $record exists" }
    else { Say 'TODO' "there is no models hash record $record. After -Apply, and after every change to the models folder: bun scripts/cynco-guard.mjs hash-models, then bun scripts/cynco-guard.mjs status (docs/containment-setup.md section 8, C0)." }
  }
}

# -- 3. The models folder ------------------------------------------------------------------------------
# CYNCO_HOME and CYNCO_MISSIONS_DIR as the logon tasks and the daemon get them (user, then machine), not
# as this terminal has them: a terminal with a scratch CYNCO_HOME must not hide the real ones.
function Get-SetVar([string]$name) { $u = Get-UserVar $name; if ($u) { return $u }; return (Get-MachineVar $name) }
function Get-FullOrAsIs([string]$p) { try { return (Get-Full $p) } catch { return $p } }
$homeSet = Get-SetVar 'CYNCO_HOME'
$cyncoHome = if ($homeSet) { $homeSet } else { Join-Path $env:USERPROFILE '.cynco' }
$defaultModels = Join-Path $cyncoHome 'models'
$modelsUser = Get-UserVar 'LOCALCODE_MODELS_DIR'
$modelsMachine = Get-MachineVar 'LOCALCODE_MODELS_DIR'
$modelsSet = if ($modelsUser) { $modelsUser } else { $modelsMachine }
$modelsFrom = if ($modelsUser) { 'user variable' } else { 'machine variable' }
$modelsTarget = ''
if ($ModelsDir) {
  $ModelsDir = $ModelsDir -replace '/', '\'
  $problems = @(Get-ModelsProblems $ModelsDir)
  if ($problems.Count -gt 0) {
    foreach ($x in $problems) { Stop-Here "-ModelsDir $ModelsDir $x." }
  } else {
    # Stored as its full form, so a trailing separator or a .. segment never reaches the engine.
    $ModelsDir = Get-Full $ModelsDir
    if ($modelsUser -and ((Get-FullOrAsIs $modelsUser) -eq $ModelsDir)) {
      Say 'ok' "LOCALCODE_MODELS_DIR=$modelsUser (user variable)"
    } else {
      $modelsTarget = $ModelsDir
      Say 'TODO' "LOCALCODE_MODELS_DIR is '$modelsUser' (user variable). -Apply sets it to $ModelsDir."
    }
  }
} elseif ($modelsSet) {
  $problems = @(Get-ModelsProblems $modelsSet)
  if ($problems.Count -gt 0) {
    foreach ($x in $problems) { Stop-Here "LOCALCODE_MODELS_DIR ($modelsFrom) is $modelsSet, which $x." }
  } else {
    Say 'ok' "LOCALCODE_MODELS_DIR=$modelsSet ($modelsFrom)"
  }
} else {
  Say 'TODO' "LOCALCODE_MODELS_DIR is not set: the models are looked for under $defaultModels, inside the home folder. docs/containment-setup.md says how they leave it."
}
$modelsNow = if ($modelsTarget) { $modelsTarget } else { $modelsSet }
if ($modelsNow -and (Test-Path -LiteralPath $defaultModels) -and ((Get-FullOrAsIs $modelsNow) -ne (Get-Full $defaultModels))) {
  Say 'TODO' "$defaultModels still exists although the models folder is $modelsNow. A process that loses the variable would serve from the home folder. Move what is in it or remove it yourself."
}
if ($modelsNow) { $kept += @{ Label = 'the models folder'; Path = (Get-FullOrAsIs $modelsNow) } }

# -- 3c. The copy of Git's Unix tools (only with -MsysCopy, or when the folder is already there) ----------
$msysTarget = ''
$msysGit = if ($GitRoot) { $GitRoot } else { Find-GitRoot }
if ($MsysCopy -or (Test-Path -LiteralPath $MsysDir)) {
  $before = $script:blocking
  $problems = @(Get-FolderProblems $MsysDir)
  foreach ($x in $problems) { if ($MsysCopy) { Stop-Here "the copy of Git's tools $MsysDir $x." } else { Say 'info' "the copy of Git's tools $MsysDir $x." } }
  if (-not $msysGit -or -not (Test-Path -LiteralPath (Join-Path $msysGit 'usr\bin\msys-2.0.dll'))) {
    if ($MsysCopy) { Stop-Here "no installed Git with usr\bin\msys-2.0.dll was found; name its folder with -GitRoot." }
  } elseif ($problems.Count -eq 0) {
    $state = Get-MsysCopyState $msysGit $MsysDir
    if ($state -eq 'current') { Say 'ok' "the copy of Git's tools $MsysDir matches the installed Git ($msysGit)" }
    elseif ($state -eq 'foreign') { Stop-Here "$MsysDir holds files and no $MsysManifestName, so this script did not make it; name another folder with -MsysDir." }
    elseif ($MsysCopy) { $msysTarget = Get-Full $MsysDir; Say 'TODO' "the copy of Git's tools $MsysDir is $state. -Apply copies it from $msysGit." }
    else { Say 'TODO' "the copy of Git's tools $MsysDir is $($state): a run whose starter names it in LOCALCODE_CONTAINMENT_MSYS is refused. Run again with -MsysCopy -Apply." }
  }
  if ($script:blocking -eq $before) { $kept += @{ Label = "the copy of Git's tools"; Path = (Get-Full $MsysDir) } }
}

# -- 3b. No two of these folders may overlap -------------------------------------------------------------
for ($i = 0; $i -lt $kept.Count; $i++) {
  for ($j = $i + 1; $j -lt $kept.Count; $j++) {
    $a = $kept[$i]; $b = $kept[$j]
    if ((Test-Inside $a.Path $b.Path) -or (Test-Inside $b.Path $a.Path)) {
      Stop-Here "$($a.Label) $($a.Path) and $($b.Label) $($b.Path) overlap: each must be a folder of its own, neither inside the other."
    }
  }
}

# -- 4. Volumes Windows cannot protect -----------------------------------------------------------------
$ackUser = Get-UserVar 'LOCALCODE_UNPROTECTED_VOLUMES_OK'
$ackTarget = ''
if ($AcknowledgeVolumes) {
  $entries = @($AcknowledgeVolumes.Split(';') | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
  $bad = @($entries | Where-Object { $_ -notmatch '^[A-Z]:$' })
  if ($bad.Count -gt 0 -or $entries.Count -eq 0) {
    Stop-Here "-AcknowledgeVolumes '$AcknowledgeVolumes' must be volume roots such as X: separated by semicolons."
  } elseif (($entries -join ';') -eq $ackUser) {
    Say 'ok' "LOCALCODE_UNPROTECTED_VOLUMES_OK=$ackUser (user variable)"
  } else {
    $ackTarget = $entries -join ';'
    Say 'TODO' "LOCALCODE_UNPROTECTED_VOLUMES_OK is '$ackUser' (user variable). -Apply sets it to $ackTarget. Acknowledging a volume does not protect it."
  }
} elseif ($ackUser) {
  Say 'info' "LOCALCODE_UNPROTECTED_VOLUMES_OK=$ackUser (user variable): acknowledged, not protected."
} else {
  Say 'info' 'LOCALCODE_UNPROTECTED_VOLUMES_OK is not set. A run refuses while a volume Windows cannot protect is attached and not named there; the refusal names the volume.'
}

# -- 5. Scheduled tasks that run something from inside a daemon mission's folder -------------------------
$missionsSet = Get-SetVar 'CYNCO_MISSIONS_DIR'
$missionsDir = if ($missionsSet) { $missionsSet } else { Join-Path $cyncoHome 'missions' }
$missionFolders = @()
if (Test-Path -LiteralPath $missionsDir) {
  foreach ($d in @(Get-ChildItem -LiteralPath $missionsDir -Directory -Force)) {
    $file = Join-Path $d.FullName 'mission.json'
    if (-not (Test-Path -LiteralPath $file)) { continue }
    try {
      $mission = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      $cwds = @($mission.cwd) + @($mission.triggers | ForEach-Object { $_.cwd })
      foreach ($c in @($cwds | Where-Object { $_ } | Select-Object -Unique)) {
        if ($c -notmatch '^[A-Za-z]:[\\/]') {
          Say 'TODO' "daemon mission $($d.Name): its cwd '$c' is not a full path, so it was not checked."
          continue
        }
        $missionFolders += @{ Id = $d.Name; Cwd = (($c -replace '/', '\').TrimEnd('\')) }
      }
    } catch {
      Say 'TODO' "daemon mission $($d.Name): mission.json could not be read ($($_.Exception.Message)), so its folder was not checked."
    }
  }
}
if ($missionFolders.Count -eq 0) {
  Say 'ok' "no daemon mission under $missionsDir names a working folder"
} else {
  $hits = 0
  $tasks = @()
  $listed = $true
  try {
    $tasks = @(Get-ScheduledTask)
  } catch {
    $listed = $false
    Stop-Daemon "the scheduled tasks could not be listed ($($_.Exception.Message)), so it is not known whether one runs something from inside a daemon mission's folder. Do not switch the daemon on before this line is gone."
  }
  foreach ($t in $tasks) {
    foreach ($a in @($t.Actions)) {
      if (-not $a.Execute) { continue }
      $what = [Environment]::ExpandEnvironmentVariables("$($a.Execute) $($a.Arguments)").Trim()
      $where = ([Environment]::ExpandEnvironmentVariables("$($a.WorkingDirectory)") -replace '/', '\').Trim('"', ' ').TrimEnd('\').ToLowerInvariant()
      $hay = (("$what " -replace '/', '\') -replace '"', '').ToLowerInvariant()
      foreach ($mf in $missionFolders) {
        $needle = $mf.Cwd.ToLowerInvariant()
        $inside = $hay.Contains($needle + '\')
        $startsThere = $where -and (($where -eq $needle) -or $where.StartsWith($needle + '\'))
        if ($inside -or $startsThere) {
          $hits++
          Stop-Daemon "scheduled task ""$($t.TaskPath)$($t.TaskName)"" runs [$what] from or inside $($mf.Cwd), the working folder of daemon mission $($mf.Id). While a task of that mission runs, contained processes can write that folder, so they could change what Task Scheduler starts at your next logon with your real home folder. Move the launcher out of the folder, or give the mission a cwd that holds no launcher. Do not switch the daemon on before this line is gone."
        }
      }
    }
  }
  if ($listed -and $hits -eq 0) { Say 'ok' "no scheduled task runs a program or script from inside a daemon mission's folder ($($missionFolders.Count) checked)" }
}

# -- 6. Is this terminal stale? -------------------------------------------------------------------------
foreach ($n in 'LOCALCODE_MODELS_DIR', 'LOCALCODE_UNPROTECTED_VOLUMES_OK', 'LOCALCODE_SANDBOX_ROOT', 'LOCALCODE_GUARD_DIR', 'LOCALCODE_AUDIT_DIR', 'CYNCO_HOME', 'CYNCO_MISSIONS_DIR') {
  $here = [Environment]::GetEnvironmentVariable($n, 'Process')
  $u = Get-UserVar $n
  $want = if ($u) { $u } else { Get-MachineVar $n }
  if ("$here" -ne "$want") {
    Say 'TODO' "this terminal has $n='$here' but a new one would have '$want': it is stale. Open a new terminal before you dispatch from it."
  }
}

# -- 7. Change what was asked for, or say what would change ----------------------------------------------
if (-not $Apply) {
  if ($script:stops -gt 0) { exit 1 }
  exit 0
}
if ($script:blocking -gt 0) { Say 'STOP' 'nothing was changed: clear the STOP lines above first.'; exit 1 }
$changed = 0
foreach ($d in $toCreate) {
  New-Item -ItemType Directory -Path $d | Out-Null
  Say 'made' $d
  $changed++
}
if ($markerNeeded -and $marker) {
  New-Item -ItemType File -Path $marker | Out-Null
  Say 'made' $marker
  $changed++
}
if ($modelsTarget) {
  [Environment]::SetEnvironmentVariable('LOCALCODE_MODELS_DIR', $modelsTarget, 'User')
  Say 'set' "LOCALCODE_MODELS_DIR=$modelsTarget (user variable; was '$modelsUser')"
  $changed++
}
if ($ackTarget) {
  [Environment]::SetEnvironmentVariable('LOCALCODE_UNPROTECTED_VOLUMES_OK', $ackTarget, 'User')
  Say 'set' "LOCALCODE_UNPROTECTED_VOLUMES_OK=$ackTarget (user variable; was '$ackUser')"
  $changed++
}
if ($msysTarget) {
  $lines = @(Copy-MsysRuntime $msysGit $msysTarget)
  foreach ($l in $lines) { $w = $l.Split(' ')[0]; Say $w $l.Substring($w.Length + 1) }
  if ($lines[-1].StartsWith('STOP')) { exit 1 }
  Say 'NEXT' "A run uses the copy only when the shell or service that starts it has LOCALCODE_CONTAINMENT_MSYS=$msysTarget; run this step again after every Git update."
  $changed++
}
if ($modelsTarget -or $ackTarget) {
  Say 'NEXT' 'Sign out and in, so the logon tasks and new terminals see the variables.'
}
if ($modelsTarget) {
  Say 'NEXT' 'Until then an engine started from a stale environment looks for the models where they were and refuses at start by name, the phone engine included.'
}
if ($ackTarget) {
  Say 'NEXT' 'Until then a run started from a stale environment does not see the acknowledgement and refuses while that volume is attached.'
}
if ($changed -eq 0) { Say 'ok' 'nothing to change.' }
if ($script:stops -gt 0) { exit 1 }
exit 0
