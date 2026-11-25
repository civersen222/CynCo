# CivKings campaign briefs

This folder is the CivKings campaigns' home for briefs (`briefsDir` in `scripts/cynco-campaign-home.mjs`): the
campaign specs (`<id>.campaign.json`), `roadmap.json`, `gate-lines.history.json` (a hand transcription) and
`campaign-log.md` are kept here; the campaign runner appends each verdict to the log and moves the roadmap's
lines, and each wave's brief is written here as `<id>-wave<n>.txt` when it is
dispatched (`scripts/cynco-campaign.mjs`), with its contract sidecar `<id>-wave<n>.contract.json` beside it
(`scripts/cynco-contract.mjs`).

The briefs are the record of what each wave was told. Those written before 2026-11-23 (the last is
`c11-wave2.txt`, 2026-10-05) tell the mission that probes and salvage live under `C:\tmp`. That is no longer
the rule for a mission: since F242 (2026-11-23) an unattended run's probes and temporary files go in its own
scratch folder, which the fixed rule of every run names (`engine/missionRule.ts`) and every brief the runner
writes now says (`SCRATCH_PHRASE` in `scripts/cynco-brief.mjs`). `C:\tmp` lies outside a contained run's
folders, so a write there is refused by the path check and, on NTFS, by the low-integrity token. Read an old
brief as a record, not as a template. `C:\tmp` is still where the harness itself, outside the box, writes a
wave's driver pid file and log and a wave's salvage (`scripts/cynco-campaign.mjs`).
