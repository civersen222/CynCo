# Containment setup (Windows)

How a machine is prepared for mission containment (F242): the folders that hold the sandboxes, the
guard state and the tool-call audit, the models folder outside the home folder, and how the settings
reach every process. `scripts/cynco-containment-setup.ps1` does the parts that can be done by a script
and reports the rest; this document is the procedure around it. It is written with placeholders:
`%USERPROFILE%` is the home folder, `<models folder>` the folder the models are moved to, `<backup share>`
a network share of your own.

## 1. What this sets up

Three folders outside the home folder, none of which a run, the daemon or a test ever creates:

| Folder | Default | Moved by |
|---|---|---|
| Sandbox root: one sandbox per unattended run | `C:\cynco-sandbox` | `LOCALCODE_SANDBOX_ROOT` |
| Guard folder: the integrity latch, manifests, the models hash record, unsent pages (written from slice S7 on; until then the folder only exists) | `C:\cynco-guard` | `LOCALCODE_GUARD_DIR` |
| Audit folder: the tool-call audit of unattended runs | `C:\cynco-audit` | `LOCALCODE_AUDIT_DIR` |

Leave the three variables unset. A process that loses a variable would otherwise look in the default
folder and find a different latch, or none. The setup script creates the folders once. The audit folder
carries an empty marker file, `.cynco-audit`, which the script writes; the audit writer refuses a
folder without it, so it never writes into a folder the script did not make.

The models can leave the home folder too: `LOCALCODE_MODELS_DIR` names the folder that holds one
sub-folder per model and the embedding GGUF in its root (section 6). Unset, the models are where they
always were, `models` under the CynCo home.

## 2. Before you start

Nothing unattended may be running: no dispatch, no campaign, no daemon task, no gate authoring.

- A process started before a variable is set keeps its old environment.
- `engine/paths.ts` is part of what the gate-authoring check fingerprints, so an authoring run in flight
  when this change lands sees a changed harness.
- From slice S7 on, any change to the models folder while a run is open writes the integrity latch. Until
  then nothing watches the folder: keep it unchanged while a run is open all the same.

Use an ordinary, non-elevated PowerShell for everything except the optional read-only step of
section 7. The script refuses an elevated one with a STOP line: with a separate administrator account its
home folder and its user variables are that account's, not yours.

## 3. Run the report, then apply

```powershell
scripts\cynco-containment-setup.ps1          # report only: changes nothing
scripts\cynco-containment-setup.ps1 -Apply   # create what the report marked TODO
```

Without `-Apply` the script reads the machine and changes nothing. It exits 1 when it printed any STOP
line, else 0. It is safe to run again at any time; a second `-Apply` finds the folders there and changes
nothing.

| Mark | Meaning |
|---|---|
| `ok` | as it should be |
| `TODO` | something to do; `-Apply` does it when the line says so, otherwise it is yours |
| `STOP` | `-Apply` changes nothing while this line is printed |
| `STOP daemon:` | does not block `-Apply`, but the daemon must not be switched on while it is printed |
| `info` | a fact, no action |
| `made` | `-Apply` created this folder or file |
| `set` | `-Apply` set this user variable |
| `NEXT` | what to do after `-Apply` |

What to do about each STOP:

- **`this PowerShell is elevated`.** Close it and run the script in an ordinary PowerShell.
- **`LOCALCODE_CONTAINMENT_OFF is set at user or machine level`.** The switch is for the test suite only;
  every dispatch, daemon task and contained engine refuses while it is set. Remove it (System
  Properties, Environment Variables), then sign out and in.
- **`the <folder> <path> (...) is not a full path below a drive letter`.** Name the folder with a full path
  such as `C:\...`, or unset the variable.
- **`... is on <drive>, which is not ready`** or **`... only a local NTFS volume carries integrity labels`.**
  Put the folder on a local NTFS volume.
- **`... is inside, or contains, the home folder`.** These folders exist to survive the loss of the home
  folder; put them outside it.
- **`... is, or is under, a link`.** No junction, symbolic link or mount point anywhere on the path
  (F161): name the real folder.
- **`... exists and is not a folder`.** Something else has the name; choose another folder.
- **`... carries a Low integrity label`.** A contained process could write it. Choose another folder, or
  remove the label yourself after finding out how it got there.
- **`... has an access list that could not be read`** or **`... has a parent (...) whose access list could
  not be read`.** `icacls` failed, so the label is unknown. Find out why (the account may not read that
  folder) before you use it.
- **`... has a parent (...) with an inheritable Low integrity label`.** The folder `-Apply` would make
  inherits it, and a contained process could write it. Choose a parent that carries no such label.
- **`<one folder> and <another> overlap`.** The sandbox root, the guard, audit and models folders must
  each be a folder of its own, neither inside another: name them apart.
- **`LOCALCODE_GUARD_DIR points at <path> and the default C:\cynco-guard also exists`.** Keep one guard
  folder: unset the variable, or remove the default folder yourself.
- **`... does not exist and neither does its parent`.** The script creates one folder, never a tree:
  create the parent yourself.
- **`the audit folder <path> is not empty and has no .cynco-audit marker`.** It was not made by the
  script. Name another folder, or empty this one yourself.
- **`-ModelsDir <path> ...`** or **`LOCALCODE_MODELS_DIR (user variable) is <path>, which ...`** (or `machine
  variable`, which is checked too when no user variable is set). The folder
  problems above, or the models folder `does not exist`, or it `holds no .gguf file in itself or in a
  direct sub-folder`. Name the folder that holds the models.
- **`-AcknowledgeVolumes '<value>' must be volume roots such as X: separated by semicolons`.** Fix the
  value.
- **`STOP daemon: scheduled task "<name>" runs [...] from or inside <cwd>, the working folder of daemon
  mission <id>`.** While a task of that mission runs, contained processes can write that folder, so they
  could change what Task Scheduler starts at your next logon. Move the launcher out of the mission's
  folder, or give the mission a working folder that holds no launcher, before you switch the daemon on.

The check for a Low label reads the output of `icacls` in English (`Mandatory Label\Low`). On a Windows
installed in another language the line does not match and the check passes without saying so.

The daemon check (section 5 of the script) and the default models folder use `CYNCO_HOME` and
`CYNCO_MISSIONS_DIR` as the logon tasks and the daemon get them (user, then machine variable), not as the
terminal running the script has them; a terminal that differs gets a `TODO` saying it is stale.

## 4. How the settings reach every process

The settings are user-level environment variables. No file is read to find them and no code passes them
on:

- the logon tasks (`scripts\run-headless-engine.cmd`, `scripts\run-embed-server.cmd`,
  `scripts\run-box-reporter.cmd` and the daemon's launcher) start with the user's environment and hand it
  to `bun` or `llama-server`;
- a daemon one-shot's child engine inherits the daemon's environment, minus the notification settings;
- a dispatch from Git Bash inherits the terminal's environment and hands it to the engine and the driver;
- the campaign runner passes its own environment through, and a campaign spec cannot carry any of these
  variables (it may set only `LOCALCODE_LLAMA_SERVER` and `LOCALCODE_MODEL_PATH`);
- the desk widget starts services only through `scripts\cynco-services.ps1` and Task Scheduler, so a
  service gets the task's environment, not the widget's.

The processes a contained run starts do not get these variables: the run's tool environment removes
them. An interactive engine's Bash tool keeps them.

After a variable is set, sign out and in once. Until then, after the models were moved, every engine
started from a stale environment looks for them where they were and refuses at start by name, the phone
engine included, so the dashboard and the phone are down until the sign-in (a stale
`LOCALCODE_UNPROTECTED_VOLUMES_OK` instead makes a run refuse while that volume is attached; the engine
starts). The reason is the last line of the engine log that starts `[llama-cpp] FATAL: setup failed:`:

```powershell
Select-String -Path <engine log> -Pattern '^\[llama-cpp\] FATAL' | Select-Object -Last 1
```

The last line of the log, which `scripts\cynco-services.ps1 status` shows, is the generic "Fix the error
above" line, not the reason. For the embedding service the reason is the last line of its log that
starts `[embed]`. The setup script's report also says when the terminal it runs in is stale.

## 5. Volumes Windows cannot protect

Integrity labels exist on NTFS only. A run refuses while a local volume that is not NTFS, a removable
volume or a mapped network drive is attached and not acknowledged; the refusal names the volume. To
acknowledge one:

```powershell
scripts\cynco-containment-setup.ps1 -AcknowledgeVolumes X: -Apply
```

This sets `LOCALCODE_UNPROTECTED_VOLUMES_OK` (several volumes: `X:;Y:`). Acknowledging does not protect
the volume. It stays refused as a write target by the path check (and, from slice S7 on, its top level is
watched), but a script a run writes and then runs is not read by that check.

## 6. Moving the models out of the home folder

Every step but M2 only reads.

- **M0, checks.** (a) The source `%USERPROFILE%\.cynco\models` is a real folder with no link anywhere
  inside: its own attributes have no `ReparsePoint`, and
  `Get-ChildItem -LiteralPath <source> -Recurse -Force -Attributes ReparsePoint` prints nothing.
  (b) `<models folder>` does not exist. (c) Note the number of files and their total size. (d) Find the
  known references to the old place: the profiles (`chat_template_file`, `model_file`, any path with
  `models\` or `models/`), the campaign specs, the apps registry (`apps.json` in the CynCo home), the
  daemon missions, and, by hand, project-local profiles of other working folders, temporary campaign
  homes still in use and the folders of your other local-LLM apps. Whatever is missed fails closed by
  name.
- **M1, profile edits.** A `chat_template_file` that is an absolute path into the old folder, or starts
  with `~`, becomes the bare file name (`chat_template_file: chat_template.jinja`): a file name is looked
  up beside the model's GGUF. A `model_file` that holds a slash or a drive becomes the bare file name.
- **M2, the rename.** One call that can only rename, never copy:
  `[System.IO.Directory]::Move('<source>', '<models folder>')`. It throws and moves nothing when the
  destination exists, when the two are on different volumes, or when a file is open (a server is still
  running: stop it). Leave no junction, link or placeholder at the old place (F161). Check: the old path
  is gone and the new folder holds the same number of files and bytes.
- **M3, read-only (optional).** Section 7, now.
- **M4, the variable.** `scripts\cynco-containment-setup.ps1 -ModelsDir <models folder> -Apply`, then open a
  new terminal and check that `$env:LOCALCODE_MODELS_DIR` prints the new folder.

## 7. Read-only models (optional)

In an elevated PowerShell. These commands recurse over the models tree, which is safe only when it holds
no link: `icacls /T` was measured to carry a label through a junction into other folders. Check again now,
right before them, even when step M0 was done (models may have been added since): both of these must print
nothing, and if either prints anything, stop.

```powershell
(Get-Item -LiteralPath '<models folder>' -Force).Attributes -band [IO.FileAttributes]::ReparsePoint
Get-ChildItem -LiteralPath '<models folder>' -Recurse -Force -Attributes ReparsePoint
```

```powershell
icacls '<models folder>' /setowner '*S-1-5-32-544' /T /C /Q
icacls '<models folder>' /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX'
icacls '<models folder>\*' /reset /T /C /Q
```

Administrators own the tree; Administrators and SYSTEM have full control; Users can read and execute; your
own account appears nowhere. The last command makes a moved tree drop the entries it inherited from the
home folder. Check, non-elevated: reading the first line of a chat template works, and creating a file in
the folder (`New-Item <models folder>\_write-probe.tmp`) is denied. If the probe file is created, remove
that one file by name and redo the three commands. Adding or removing a model then needs an elevated
shell. Nothing in the engine writes to the models folder: slot snapshots, checkpoint calibration,
binaries and adapters live under the CynCo home.

## 8. Start check

- **C1.** `scripts\cynco-services.ps1 start embed`. In the embed log the last line that starts `[embed]` is
  `[embed] model "<models folder>\nomic-embed-text-v1.5.f16.gguf"` (the server's own lines follow it);
  `http://127.0.0.1:9165/health` answers 200.
- **C2.** `scripts\cynco-services.ps1 start engine`. The newest `[llama-cpp] Model:` line of the engine log
  names a file under `<models folder>`, and no `[llama-cpp] FATAL` line follows it (the model and the chat
  template are resolved at start even on a lazy engine).
- **C3.** Send one message from the dashboard. The log shows `[llama-cpp] Starting:` with `--model` and
  `--chat-template-file` under `<models folder>`, then `Chat template supports native tool calls`. This
  also shows that llama-server needs no write access to the folder.
- **C4.** `Test-Path %USERPROFILE%\.cynco\models` is False.
- **C5.** If C1 or C2 shows the old folder or a refusal naming it, the task's environment is stale: sign
  out and in, and repeat. The daemon is checked the same way at its first one-shot.

## 9. A backup copy on another machine (optional)

Nothing checks that this was done. Copy with one stream, throttled, listing first:

```powershell
robocopy <models folder> <backup share>\models /E /COPY:DAT /DCOPY:T /XJ /R:3 /W:60 /IoRate:40M /NP /L
robocopy <models folder> <backup share>\models /E /COPY:DAT /DCOPY:T /XJ /R:3 /W:60 /IoRate:40M /NP /TEE /LOG+:<log folder>\models-backup.log
```

`/LOG+:` appends, so a later copy does not erase the earlier record; keep the log in a folder of your own
outside the home folder, not in the guard or audit folder. Never `/MIR`, `/PURGE`, `/MOV` or `/MOVE`:
nothing is ever deleted at the source or on the share. An exit code below 8 is success. Verify by reading
back: the SHA-256 of each file on the share equals the hashes in the guard folder's record, and the share
holds exactly those files. Until slice S7 writes that record, compare with hashes you took yourself
(`Get-FileHash -Algorithm SHA256`) before the copy.

A share carries no integrity labels, so a contained run that can reach it can delete it. What protects
the copy is the share itself: snapshots on the share, or an account whose password is not stored in your
session.

## 10. Changing the models later

Only while no mission, campaign or daemon task is running: from slice S7 on, a change in the models
folder during a run writes the latch and pages you. From an elevated shell when the folder is read-only.

## 11. Undoing the move

With every service stopped, in an elevated PowerShell: move the folder back with
`[System.IO.Directory]::Move('<models folder>', '<source>')`; if section 7 was done, first run the two
link checks of section 7 on `<source>` (both must print nothing; if either prints anything, stop), then
give the restored folder back to your account and reset it (`icacls '<source>' /setowner <your account>
/T /C /Q`, then `icacls '<source>' /reset /T /C /Q`, in that order, so the tree takes the home folder's
inherited entries);
remove the user variable `LOCALCODE_MODELS_DIR`; sign out and in. The code needs no rollback: with the
variable removed it looks where it always did.

## 12. Other operating systems

The three `C:/` defaults do not exist there, and the audit folder has no default at all, so an unattended
run refuses until `LOCALCODE_SANDBOX_ROOT`, `LOCALCODE_GUARD_DIR` and `LOCALCODE_AUDIT_DIR` name existing
folders outside the home folder (the audit folder with an empty file named `.cynco-audit` in it), set in
the environment of whatever starts the engine and the dispatch. There is no setup script and no kernel
layer there: the engine reports `contained-overlay`.
