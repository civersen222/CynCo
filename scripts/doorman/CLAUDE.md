# scripts/doorman

## Purpose
What runs on the doorman, the always-on mini PC (Beelink N100, Ubuntu 24.04, Python 3.12, tailnet `100.110.117.10`): the front door that wakes the GPU boxes (`doorman.py`), the NAS watchdog (`naswatch.py`), ntfy (a container), and since 2026-11-12 the **watcher**, the always-on part of the metasystem. All of it is Python with the standard library only, deployed by copying files (`deploy.sh`); nothing from the TypeScript engine runs here. Designs: `docs/decisions/2026-11-08-wakefulness-design.md` (the doorman, naswatch, ntfy) and `docs/decisions/2026-11-11-metasystem-design.md` (the watcher; slice 1 of six is built: memory and the note, observation only).

The watcher never asks a box for anything. Each box pushes its own state, so watching cannot wake a sleeping box and nothing new listens on a working one. It takes no action on any box, service or app, and its core is deterministic.

## Key files
| File | Role |
|---|---|
| `doorman.py` | The wake service on port 9170: `/wake`, `/status`, `/schedule`, the waking page. Since slice 1 it also writes each wake burst it starts to `/var/lib/doorman/bursts.jsonl` (`jsonl_recorder`), with the cause: `knock`, `schedule` (and the time it was scheduled for) or `with:<target>` for a companion. |
| `watcher.py` | The watcher's service on port 9171: `POST /push`, the note (`GET /`, `/day/YYYY-MM-DD`), the same findings as data (`/findings.json?day=`), `/healthz`; a background read of the doorman's burst journal and schedule file (`ingest_doorman_files`, `keep_reading`). |
| `watchstore.py` | The memory: one SQLite file (`/var/lib/cynco-watcher/watch.db`). `Store.add` keeps a record under the time it describes; samples are unique on (box, at) and events on (box, kind, key), so a repeated push stores nothing twice. |
| `watchmodel.py` | The model, pure: `timeline`, `wakes`, `service_bands`, `model_bands`, `holder_bands`, `measures`, `findings_by_construction`, `classify` (the filter), `series`, `findings_by_comparison`, `day_report`. Every sensitivity is a constant at the top of this file. |
| `watchnote.py` | The page, pure: `render(report)` and `findings_json(report)`. Inline SVG, no script, no form, nothing fetched. |
| `journal_bursts.py` | The doorman's bursts read back out of its systemd journal (`sudo ... etherwake` lines, `GET /wake` lines), for days before the burst journal existed and for the 2026-11-11 fixture. |
| `naswatch.py` | Router first, then the NAS; ntfy on a change of state only. |
| `deploy.sh` | Copies the files and unit files to the doorman and restarts the services. Run by the owner from the repo root on the PC; never by a session. |
| `doorman.service`, `naswatch.service`, `watcher.service` | The systemd units. The watcher runs as `cynco`, with `StateDirectory=cynco-watcher`. |
| `fixtures/2026-11-11/` | The real records of that day (README inside says what is real and what is reconstructed) and `pushes.json`, what the main PC's reporter makes of them. `fixtures/cusum-parity.json` pins the CUSUM detector against the engine's. |
| `test_*.py` | pytest files. `scripts/__tests__/doorman-python.test.mjs` runs them inside `npx vitest run`. |

## What a box pushes (protocol v1)
`POST /push` with `{"v":1,"box":"main","sentAt":iso,"records":[...]}`; the answer is `{"ok":true,"stored":n,"duplicates":n,"rejected":n}`. The types are in `engine/power/reporter/types.ts`. A record is a **sample** (`{"t":"sample","at":iso, idleS, gpus, models, holder, engine, services}`; a field the box could not read is `null`) or an **event** (`{"t":"event","at":iso,"kind","key","data"}`). Kinds: `power.sleep` `{reason}`, `power.wake` `{sleepAt, source}`, `power.boot`, `power.shutdown`, `job.run` `{mission, triggerId, ok, summary}`, `engine.loop_blocked` `{seconds, until}`, `service.said_down` / `service.said_up` `{service, by, text}`, `reporter.start`, `reporter.dropped` `{n}`. The doorman's own facts are events of the box `doorman`: `doorman.burst` `{target, cause, forAt}`, `doorman.schedule` `{targets}`. A box name is `[A-Za-z0-9_.-]{1,64}`; a body is at most 1 MiB and 500 records.

## The model
- **Timeline** per box: `asleep` and `off` from its own power events; `awake` from its samples, and between a wake and the next sleep when no sample exists (basis `idle sleep` when the sleep was the idle timer); `silent` for a gap in the samples longer than `SILENT_GAP_S` (300 s) that no sleep or shutdown covers; `unknown` where nothing was reported.
- **Wrong by construction** (no history needed): `wake.unexplained`, a wake with no doorman burst for that box in the 120 s before it and no owner input at that moment, all of a box's in a day as one finding; `service.down`, a wanted service not answering for 180 s or more, or said to be down by its dependent; `model.unused`, a model loaded with no request for 20 minutes; `box.silent`, a closed silent stretch. Windows' wake source is shown and never trusted: F221's eight wakes all read "Power Button".
- **Wrong by comparison** (`classify`): rolling median of 30 readings, scale 1.4826 × MAD with a floor, a reading beyond 3 sigma is a `transient` unless three in a row make a `step`; a CUSUM (slack 0.5, threshold 5, the definition of `CusumDetector` in `engine/cybernetics-core/src/metrics/index.ts`) with no outlier is a `slope`. Only step and slope are findings. A series speaks after 12 readings over 3 days and says "still learning" until then. The series today: each GPU's hourly median temperature, idle and under load.
- **Measures**, 0 to 1: asleep when it could be, loaded and unused, answering when wanted per service, each job's success rate. `None` when there is nothing to measure. Hand-off time waits for the attention loop (slice 4).

## Switched on by
The unit `watcher.service` on the doorman (`deploy.sh` installs and enables it). Stopped: `sudo systemctl disable --now watcher`; every box keeps working, the PC's reporter keeps a bounded backlog and sends it when the watcher is back. Removed: delete `/etc/systemd/system/watcher.service` and `/var/lib/cynco-watcher`; the model then starts from nothing. Nothing else depends on it. The boxes' side is `engine/power/CLAUDE.md` (the box reporter, `LOCALCODE_WATCHER_URL`).

## Gotchas
- Bind the Tailscale address only: `watcher.py` and `doorman.py` both refuse `0.0.0.0` and `::`. There is no authentication beyond the tailnet, as for the doorman's own routes: any tailnet device can push records. What that can do is bounded (one box name per push, 1 MiB) and it can never make the watcher act, because nothing here acts.
- The page takes no input and `test_watchnote.py` pins it: no script, form, input, button, event handler, external URL, font or stylesheet. Links go to `/` and `/day/<date>` only.
- The owner's three answers to a finding are **not built** (`docs/NOW.md`): the page says so, and no table for them exists.
- A box's sleep is reported after it wakes. Until then the page says the box is silent, with no sleep reported yet; it becomes `asleep` when the box's System log arrives. A silence that is still going on is a status line, not a finding.
- `journalctl --utc` changes how times are printed, not how `--since` is read: write `--since "2026-11-11 09:30:00 UTC"`. And a user outside `systemd-journal` gets "No entries" for another unit's lines; read with `sudo` (F228).
- The burst journal is trimmed by the doorman (rewritten to its newest half over 20,000 lines); the watcher notices the shorter file and reads it again, which stores nothing twice.
- Line endings: everything under `fixtures/` is pinned to LF by `.gitattributes` (`scripts/doorman/fixtures/** text eol=lf`), because a Windows checkout with `core.autocrlf=true` otherwise hands the tests CRLF copies (F231). The readers themselves must not care either way: `journal_bursts.parse` and `watcher.ingest_doorman_files` are tested with the same input in LF and CRLF (`test_doorman_bursts.py`, `test_watcher.py`), and a new reader of lines gets the same test.
- A day is the owner's local day. The offset comes from the doorman's own time zone unless `--tz-offset-min` is given; the tests always give it.
- The watcher's tests start servers on `127.0.0.1` with port 0. Nothing in this folder's tests touches the doorman.
- Python on the doorman is 3.12: no syntax newer than that, and `datetime.fromisoformat` there takes at most six fractional digits (`watchstore.parse_iso` cuts Windows' seven).
