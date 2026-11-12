# The records of 2026-11-11

The proof for metasystem slice 1 (`docs/decisions/2026-11-11-metasystem-design.md`): replayed through the main PC's reporter and the watcher, these records must put the night of F221 and the embedding outage of F215 on the note. Replayed by `scripts/doorman/test_watch_replay.py` (the watcher alone) and `engine/__tests__/power/replay20261111.test.ts` (the reporter's parsers and outbox, and a real watcher process).

Nothing here was typed in by hand except `outage.json` and `targets.json`, and `outage.json` says for each of its two times how it is known.

| File | What it is | Real or reconstructed |
|---|---|---|
| `system-log.json` | The main PC's Windows System log, 2026-11-11 09:00Z to 15:00Z: `Power-Troubleshooter` 1 (nine wakes, each with its sleep time and Windows' wake source), `Kernel-Power` 42 and 107 (nine sleeps, reason 7 = the idle timer), `Kernel-General` 12 and 13 (the three restarts of the update at 09:47Z to 09:49Z). Exported read-only on 2026-11-12 with `Get-WinEvent`; record id, event id, provider, time and the event's named data, nothing else. | Real |
| `doorman-journal.txt` | The doorman's journal for its own unit, 2026-11-11 09:00Z to 19:30Z, without the `pam_unix` session lines: every `POST /schedule` from the PC and every `sudo etherwake` it ran. Read with `sudo journalctl -u doorman --utc -o short-iso -q --since "2026-11-11 00:00:00 UTC"`. It shows a burst at 09:11:08Z and at 10:11:09Z (the hourly digest's scheduled wake, last packet 10:12:10Z), no line at all until the PC's daemon posts its schedule again at 15:06:47Z, and no `etherwake` until 19:12:00Z. | Real |
| `engine-log-excerpt.txt` | 56 lines of `~/.cynco/engine-headless.log` from one engine start: from `[audit] Initialized` to `[localcode] Index ready ... last: 2026-11-11T15:06:00.871Z`, with the line `[embed] No embedding endpoint answered at http://127.0.0.1:9165`. One line was left out: the one that prints a pairing code. | Real, one line omitted |
| `outage.json` | The two times of the outage and how firmly each is known. | Hand-written from the records it names |
| `targets.json` | The doorman's targets as deployed that day (the two MAC addresses in the journal). | Real values, hand-written |
| `pushes.json` | What the reporter makes of the above: 26 events. Built by `bun engine/__tests__/power/replay20261111.fixture.ts --write`; a test fails when it is not what the parsers produce. | Derived |

## What can and cannot be timed

**The wakes (F221).** All real. Nine sleeps and nine wakes between 10:10:16Z and 14:46:47Z. The first wake, 10:11:17Z, has the doorman's burst of 10:11:09Z eight seconds before it. The other eight (10:46:46, 11:16:46, 11:47:54, 12:18:02, 12:47:55, 13:17:55, 14:02:55, 14:46:47Z) have nothing: after the last packet of that burst (10:12:10Z) the journal has no line of any kind until 15:06:47Z and no `etherwake` until 19:12:00Z. Windows names "Power Button" as the source of all eight.

**The outage (F215).**
- *Said to be down, 15:06:00Z: anchored.* The engine log carries no times. The engine's own line sits 39 lines above the index stamp `2026-11-11T15:06:00.871Z` of the same engine start, so it was written at or seconds before that.
- *Back, 17:18:12Z: reconstructed.* No log line records the service coming back. F215 in `docs/cynco-failure-log.md` records that it was started by hand at 10:18:12 local (UTC−7), read that day from the task's last-run time, which has since been overwritten (2026-11-11T21:43:08Z when this fixture was made).
- *Not established:* when the service stopped answering. Its 49-hour run ended with the planned restart (shutdown 09:47:06Z). Nobody was logged on until 14:59:00Z, so no engine ran and nothing depended on the service in between; what kept it from starting at logon is not known, because Task Scheduler's history log is disabled on that PC.
- *Not in the fixture:* any reading of port 9165. The reporter did not exist that day, so there is no sample, and none was made up. The outage is opened by the engine's own words and closed by the recorded restart, as two `service.said_*` events whose data says `timeIs: anchored` and `timeIs: reconstructed` with the basis.

No sample of any kind exists for that day (GPU, idle time, services): the note for it shows the time between the wakes as awake on the basis of the idle sleeps that ended each stretch, and everything else as unknown.
