# The metasystem: one watcher above everything the owner runs on local models

**Date:** 2026-11-11 · **Status:** approved by the owner on 2026-11-11 with the five recommendations as written ("1070 ti. Approve"). Slice 1 (memory and the note) was built on 2026-11-12 and has been live since 2026-11-12 04:40Z on the doorman and the main PC, at the owner's word ("Do it live"); see "Slice 1 as built" at the end. Slices 2 to 6 are not built.

Companion records: `docs/decisions/2026-11-08-wakefulness-design.md` (the boxes, the doorman), `docs/decisions/2026-11-11-local-llm-apps.md` (the apps as CynCo's use cases), `docs/decisions/2026-11-08-image-box-design.md`, the owner's `pc-wakefulness/knowledge/tiering-preview.md`, `engine/vsm/CLAUDE.md`, `engine/cybernetics-core/README.md`.

## Intent and the why

On 2026-11-11 everything that should have been noticed or decided by the system was noticed or decided by the owner. A chat test took the GPU from a game in play. Every scheduled digest woke the image box, which it never uses. CynCo's embedding service (port 9165) was down for hours and only a log line knew. The PC slept by itself and was woken every half hour all night (F221). Docker, which the owner had ruled out, was proposed twice in one evening (F227). In each case the regulator was a person.

What the owner asked for, in their words:

- "sense, oh, the user is using a different one of these things that is GPU or CPU intensive. Let's pause the other ones that are running right now, focus on what that's going, and then if you start using something else, go on to that and pause what they're using now."
- "a watcher that would notice something is down, or something is off, or something is failing, or ... something in general is going on, and send some sort of action to be taken."
- "It should remember what we've done, because how is it going to know if something's wrong or compare it to a prior state unless it can do that?"
- "note telling me what had happened ... Maybe graphs and charts so I can observe things that have happened and make actions off those, but only be alerted for, like, extreme perturbations."
- Worth waking them for: "Intruder alert. GPU about to be on fire because some process made it go crazy." And then: "it should definitely stop something if it's going to be like catastrophic failure".
- "How would this work in a true cybernetic system? That's what I'm aiming for."

The apps are, in the owner's words, "aspects of the same cynco system just different use cases". So the system this design regulates is not the CynCo engine. It is the household: every box, and every use case that runs a local model on one.

## What cybernetics obliges the design to do

Each line is an idea, its source, and the obligation it puts on this design. A design that only borrowed the words would skip the obligations.

| Idea | Source | What it obliges here |
|---|---|---|
| A viable system has operations (System 1), coordination that damps their clashes (2), management of the inside and now with a resource bargain and a direct audit (3, 3*), a look outside and ahead (4), and identity and policy (5). Systems 3, 4 and 5 are the metasystem. Viable systems nest. | Beer, *Brain of the Firm* (1972); "The Viable System Model" (1984) | Name each function and give each exactly one owner. Do not rebuild the engine's per-conversation governance one level up: it is the next recursion down and stays where it is. |
| System 1 units get "the maximum autonomy consistent with effective organisation". | Beer, "Fanfare for Effective Freedom" (1973) | Every unit keeps working when the watcher is dead. Where a unit has its own way to yield, the watcher asks; it does not reach inside. |
| System 2 exists because units sharing a resource oscillate. | Beer (1984) | Following the owner's attention is coordination, not command. It needs a dwell time so that flicking between two apps does not thrash the GPU. |
| The audit channel (3*) reads the operation directly, not its own report of itself. | Beer, *Diagnosing the System* (1985) | GPU state, ports and sleep logs are measured, not asked for. An app saying "I am idle" is not evidence. |
| The algedonic signal is a different kind of signal from routine reporting: it goes to the responsible unit first, with a clock set per indicator, and upward only when the unit has not corrected it. | Beer (1973) | Alarms are a separate path with a short fixed list of triggers. They are not "the top of the anomaly score". |
| Cyberstride charted everything and reported little: each new reading was classified as noise, a transient, a change of slope or a step, and only the last two were reported. Beer called calibrating that sensitivity the one severe problem. | Beer (1973); Harrison and Stevens, "A Bayesian Approach to Short-term Forecasting" (1971) | Chart every series. Put only changes of slope and steps in the note. Treat the filter's sensitivity as the thing most likely to be wrong, and measure it. |
| Essential variables must stay inside limits. Ordinary feedback works inside them; when one leaves, an ultrastable system changes its configuration by a step, it does not shout louder. | Ashby, *Design for a Brain* (1952), *An Introduction to Cybernetics* (1956) | Name the few essential variables with hard limits. A breach stops the job or closes the door. It is never a bigger notification. |
| Requisite variety: a regulator needs as many distinct responses as there are distinct disturbances. | Ashby (1956) | Do not promise to regulate what the watcher has no response for. A disturbance with no response is recorded, not "handled". |
| Every good regulator of a system must be a model of that system. | Conant and Ashby (1970) | The memory is the model. "Wrong" means a departure from what the model predicts for this box, this hour and this activity, not a fixed threshold crossed. |
| Inferred attention is a hypothesis about what the person is controlling for. | Powers, *Behavior: The Control of Perception* (1973) | What the watcher believes the owner is using is a guess to be tested. An explicit choice by the owner overrides it at once. |
| The observer is inside the system; understanding is checked by teachback. | von Foerster (1979); Pask, *Conversation Theory* (1976) | The owner is System 5, not a user to notify. The note says what the watcher believed and did, and the owner's correction changes the model. |
| Without System 4, System 5 collapses into System 3 and the whole only reacts. A metasystem can come to serve itself. | Beer (1984); *Heart of Enterprise* (1979) | Keep a small look-ahead job. Cap and measure the watcher's own cost in watts and attention. |

Two of these were not checked against the primary text in this session and rest on secondary pages or memory: Beer's wording on intervention only for cohesion, and "pathological autopoiesis". The Cyberstride description was read in Beer's own 1973 text.

## The system in focus

| Function | Who or what holds it | Today |
|---|---|---|
| System 1, the use cases | The CynCo chat and coding engine; the daemon's scheduled jobs (fantasyman); dndai; screenplayer; wagetheory; Gilded; the image box's looking and drawing; and anything else heavy the owner runs, such as a game or a video editor | Each runs on its own. Only dndai and the Ollama apps are known to CynCo (`~/.cynco/apps.json`). |
| System 2, coordination | "The thing the owner is using holds the GPU" | Scattered rules inside the engine on the main PC, firing only when CynCo itself needs port 8081 (`engine/apps/`, `gpu-busy.json`, `portOwner`). |
| System 3, inside and now | Which box does which job; what is awake; what is loaded | The owner. `tiering-preview.md` names it as S5's "first real, cheap, measurable decision" and nothing implements it. |
| System 3*, audit | Direct reading of GPUs, ports, services and sleep logs | `naswatch.py` for the NAS and router only. |
| System 4, outside and ahead | What is changing: disk filling, a model worth trying, a job getting slower | Nobody. |
| System 5, identity and policy | The owner, and the written rules they have set | The owner's head and the session memory. "No Docker beside the models" lived nowhere the system could read. |
| Algedonic channel | The alarm | ntfy at priority 5 for a mission HALT or a failure streak; nothing for hardware or intrusion. |

The engine's own governance (`engine/vsm`, `engine/s5`) regulates one conversation or one mission. It is one System 1 unit's internal management and this design does not touch it.

## Four kinds of authority

The owner settled the first three in conversation. The fourth follows from the repository's own rule that policy earns authority in steps.

| Loop | Cybernetic function | Authority | What the owner sees |
|---|---|---|---|
| **Attention** | System 2 | Acts on its own | The thing they are using has the machine |
| **Watch** | System 3*, memory, the Cyberstride filter | Records. Suggests an action where it knows one; the owner takes it with one tap | A note and charts, when they choose to look |
| **Allocation** | System 3's resource bargain: which box does a job, what is woken | Advises in the note until the owner switches a rule on; then acts by that rule | "The image box was woken for nothing eleven times; stop doing that?" |
| **Alarm** | Algedonic channel and ultrastability | Acts first, then tells the owner, at any hour | A notification that says what was stopped and why |

"Records" is the default for everything not named in another row.

### The attention loop

**What "the owner is using X" means.** The evidence must tie the owner's own input to the unit. Model requests alone are not evidence: a script, an agent or a scheduled job makes them too, and on 2026-11-11 exactly that took the GPU from a game. The belief, strongest first:

1. The owner said so: they started an app from its icon or picked it on the dashboard. This wins at once.
2. The owner's input is going to the unit right now: its window or page is the one receiving keyboard and mouse, or it is the phone session they are typing in. This covers software CynCo has never heard of. A game in the foreground is the owner's activity.
3. Work that arrives with none of the owner's input directed at it is unattended, whoever is at the keyboard elsewhere. It waits, or is answered by the smaller model on the other box.

**What it does.** When the belief changes to X, every other registered heavy unit on that GPU yields and X gets it. Granting is fast (seconds). Taking back is slow (minutes without input), which is the dwell time that stops thrashing.

**What it never does.** It never pauses or stops software it does not manage. A game is never made to yield; registered units yield to it.

**What "pause" is, per kind of unit, and what exists today.**

| Unit | Yield | Resume | Exists today |
|---|---|---|---|
| An app with its own model server (dndai) | Its server is stopped from outside and the fact recorded (`displaceApp`). The app has no yield of its own to ask for. | Started again (`restoreDisplacedApps`) | Yes, proven live 2026-11-12, except for a server started elevated, which is refused (F223) |
| An app that uses Ollama | Ollama is asked to unload | The app's next request reloads it | The unload exists. Nothing stops the reload: CynCo does not police an app's requests. A reload while the owner is using something else is a clash the watch loop records; the attention loop has no response to it. |
| The CynCo chat engine | Unload now | Lazy load on the next message | Only a timer exists (`LOCALCODE_LLAMA_IDLE_UNLOAD_MS`, 15 minutes on the phone engine, off by default). Unload on request is new. |
| A scheduled job not yet started | Deferred until the owner's use ends | Runs then | New. Today the daemon does the opposite: it takes the GPU from an app before it checks whether the GPU is busy (`takeGpuForOneShot`). |
| A scheduled job already running | See "Decisions for the owner" | | New |

Running a deferred job on a smaller box instead is the allocation loop's business and needs the "worker" notion the wakefulness design names as missing.

**Where it runs.** On the box whose GPU is being shared, in that box's own small service (see "Where it runs"). The sensing and the acting are both local, and the switch must work when the network or the watcher is down. The watcher sets the rule, sees every switch, and measures how it went.

### The watch loop

**How state reaches the watcher.** Each box pushes its own state to the doorman, the way the daemon already posts its wake schedule there. The doorman never asks a box for anything, so watching cannot wake a sleeping box, and nothing new listens on a working box. A box that has said "going to sleep" and then says nothing is asleep. A box that goes silent without saying so is an event.

**What is recorded.** For every box, service, app and job, a sample on a fixed beat and an event on every change: awake or asleep and what woke it; which unit held each GPU; what was loaded and whether anything was using it; temperatures; which services answered; each job's start, end and outcome; each attention switch and how long it took.

**The model.** For each series, what is normal for this box at this hour of the week and this kind of owner activity. From the raw series the watcher derives a few measures on a 0 to 1 scale, after Beer's actuality, capability and potentiality:

- **Asleep when it could be:** hours a box was asleep, over hours nothing needed it. For the four hours of F221 that the System log shows (10:31Z to 14:46Z on 2026-11-11) it would have read about 0.4: 109 minutes asleep out of 255.
- **Loaded and unused:** minutes a model sat in memory with no request. The owner's rule is that this should be near zero.
- **Answering when wanted:** for each service, the share of the time it answered while something depended on it.
- **Hand-off time:** from the owner starting to use a thing to that thing holding the GPU.
- **Jobs:** each trigger's success rate and duration.

**Two kinds of finding.**

- **Wrong by construction**, needing no history: a wake with no doorman knock and no scheduled job behind it; a service that something depends on not answering; a model loaded with nothing using it. F221 and the embedding outage are both of this kind, so the watcher can flag them on its first day.
- **Wrong by comparison**, needing a baseline: a job getting slower, a box warmer than it usually runs. Until a series has enough history the watcher says "still learning" for it and flags nothing.

**The filter.** For the second kind, each new reading is classified as noise, a transient, a change of slope or a step. Everything is charted. Only a change of slope or a step goes in the note. The first version is a rolling median and a CUSUM change detector, the same definition the engine uses for its per-conversation failure rates (`engine/cybernetics-core/src/metrics/`), written again for the doorman. Harrison and Stevens is the reference, not a requirement for slice 1.

**The note.** One page a day, read when the owner chooses. For each thing it flagged: what was seen, what the model expected, what the watcher believes it means, and a suggested action where it knows one ("start the embedding service"). The owner can:

- take the suggested action with one tap, which is carried out on the box concerned;
- answer "that was me", "that is normal now" or "that is wrong", which changes the model.

An item nobody has answered that is still true the next day moves up the page. It does not become an alert.

**The charts.** A timeline per box (awake, asleep, who held the GPU, temperature), services up and down, hand-offs, and jobs, with the flagged changes marked.

**Where the owner reads and answers.** The note and charts are readable on the doorman, so they are there when the PC is asleep. Answers and taps are given on the CynCo dashboard, which already knows the owner's paired devices; the PC passes them on. The doorman's page takes no input.

### The allocation loop

Which box a job runs on, and which boxes are woken for it, is a decision the system does not make today: the doorman wakes the image box for every scheduled job because the main PC's target names it. This loop starts as advice in the note, built from the watch loop's record ("this job has never used the image box"). The owner switches a rule on, and from then on it is applied. Inputs, from `tiering-preview.md`: "task class, context size, deadline, what is already awake, watts".

### The alarm loop

The essential variables, each with a hard limit, a response that changes configuration, and a notice at the highest priority after the response has been made:

| Essential variable | Breach | Response |
|---|---|---|
| GPU temperature, per card | Above the card's safe limit for longer than a few seconds | The box itself stops the process driving the card and unloads models; if the temperature keeps rising, the box shuts down |
| Access | See "Decisions for the owner" for what counts | The remote doors are closed, by the machine that owns each door |
| System disk | Nearly full and still filling | The unit doing the writing is stopped |
| Memory | The machine is about to exhaust its commit charge (F140) | The unit responsible is stopped if it is CynCo's or a registered app's; otherwise notice only |

Rules for this loop:

- **Every response is carried out by the box it concerns.** The thermal response must not depend on a network or on another machine being awake. Closing the PC's remote doors (revoking paired devices, stopping the HTTPS proxy) is a management action that only the PC itself may take, and that boundary is not widened: the PC's own service does it, on its own evidence or on the doorman's word. The doorman's word can only close doors, never open them.
- **The watcher is the second line.** It alarms if a box has gone silent while hot.
- **The list is short and fixed.** Only the owner adds to it.
- **The limits come from the hardware vendor's figures** and are written in one place. None is invented here.
- **Outside the thermal case, only CynCo's own processes and registered apps are stopped.** The owner's other software is never killed to protect a number.
- **Coverage follows the local part.** The main PC is covered first. The 4070 Ti Super box and the GTX box are covered when each has its local part installed; until then their temperatures are not watched and the design says so.

## Where it runs

The watcher needs three things: to be awake when everything else is asleep, to be able to wake the others, and to cost little to leave on.

**Recommended.** Two organs.

- **The always-on part lives on the doorman** (Beelink N100, already on at all hours, already wired to the wake switch, already running the doorman, ntfy and the NAS watchdog). It holds the memory, the model, the filter, the note and charts, the alarm routing and the allocation rules. Like `doorman.py` and `naswatch.py` it is Python with the standard library only, run as its own systemd service. Nothing from the TypeScript engine runs there.
- **The GTX box (a GTX 1070 Ti, 8 GB) is the metasystem's helper**, woken when there is thinking to do that needs a GPU: writing the note in plain language, embeddings, speech. It is also the third tier for jobs.

This is the owner's intent, that the small GTX box serves the metasystem, with the reflexes placed on the machine that never sleeps and can wake the rest. The alternative is in "Decisions for the owner".

**On each working box, a small service of its own.** It pushes the box's state, runs that box's attention loop, and holds its reflexes. It is not part of the engine: a reflex that dies with the engine, or stalls while the engine's event loop is blocked (F225), protects nothing. On the main PC it is one more scheduled task beside `engine`, `daemon`, `embed` and `listener`, and it acts through what already exists (`scripts/cynco-apps.mjs take` and `give-back`, the services script). The 4070 Ti Super box has no SSH and exposes only Ollama and ComfyUI; installing its local part is a step for the owner at that machine.

The watcher's core is deterministic. A regulator that guesses in prose is not a regulator; a language model may write up what the deterministic part found, and nothing more.

## What is reused and what is new

Reused as they are, on the boxes: the apps registry and its take and give-back (`engine/apps/`), `gpu-busy.json`, `portOwner`, the activity registry (`engine/power/activity.ts`, whose `snapshot()` has no caller yet), the event-loop-blocked line, the launcher's Docker refusal as the pattern for a guarded rule. Reused on the doorman: its wake API and schedule, the ntfy container, and `naswatch.py`'s rule of alerting only on a change of state. Reused as definitions, not as code: the CUSUM detector and the vocabulary of `engine/cybernetics-core` (algedonic channel, homeostat, variety), of which this is the second recursion.

New, with the six questions from `AGENTS.md` answered in a line each:

| New thing | Problem | Why the existing thing is not enough | State and failure it adds | Verified by | Disabled by | Maintained with |
|---|---|---|---|---|---|---|
| A local service on each box | Nothing outside a box knows its GPU, load, input or temperature, and a reflex inside the engine dies with it | The engine reports one conversation | One more scheduled task; if it stops, the box is unwatched and says nothing | A test per field; stand-ins that breach each limit | Stopping the task | `engine/power/` |
| A push route and a store on the doorman | No history of machines, services or apps exists | The governance DB and the ledger hold sessions and missions | One SQLite file; if lost, the model restarts from nothing | Replaying recorded days through the filter | Stopping the service | `scripts/doorman/` |
| The note and charts page | Nothing shows the household over time | The dashboard charts one engine and is down when the PC sleeps | A page on the doorman's tailnet address that takes no input | Rendering recorded days | Not serving it | `scripts/doorman/` |
| A policy register | Rules the owner set live only in memory | Nothing the system reads | One file of rules, each with its date and the owner's words | A guard per rule, like the Docker one | Deleting a rule | `docs/decisions/` |
| The attention loop | The GPU follows a fixed rule, not the owner | `engine/apps/` acts only when CynCo needs the port, and the daemon takes the GPU without asking | A belief about the owner's activity, which can be wrong | The shadow period below | One switch | `engine/apps/` |
| The alarm loop | No response to hardware or intrusion | ntfy fires for mission failures only | The authority to stop processes and close remote access | Stand-ins that breach each limit | One switch per variable | `engine/power/` and the doorman |

## How authority is earned

The repository's rule is observe, then advise, then enforce (`AGENTS.md`; `engine/s5/ruleAuthority.ts` is the pattern).

- **Watch** is observation by nature and can go live as soon as it is correct.
- **Attention** starts in shadow: for a period it records "I would have paused X for Y" in the note and the owner marks each one right or wrong. It is switched on for a unit when its shadow record is clean. The failure to avoid at all costs is pausing the thing the owner is actually using.
- **Allocation** advises until the owner switches a rule on.
- **Alarm** goes live per variable, each after a stand-in has breached its limit and the response has been seen to work.

## How it will be known to work

- Hand-off time, measured, no worse than the model's own load time.
- Wrong pauses, counted from the owner's marks: none.
- Loaded-and-unused minutes per day fall; asleep-when-it-could-be rises. Both are a proxy for energy, which is the point of the wakefulness work.
- A night like F221 is on the next morning's note without anyone looking for it; a service down like the embedding service is on the charts within minutes.
- Alerts per month can be counted on one hand, and each false one is logged as a failure.
- The watcher's own cost, in watts and in items the owner had to read, is on its own chart.

## Non-goals and anti-goals

- Not a scheduler that commands apps.
- Never a single point of failure: with the watcher dead, everything runs and the local reflexes still protect the hardware.
- It does not reach into a conversation's governance.
- It does not fix what it notices on its own, outside the alarm loop and the rules the owner has switched on. The owner asked for a note.
- Nothing leaves the tailnet. No cloud.
- No heavy always-on process on the main PC, and no Docker there.
- No widening of the phone-access boundary: management of the PC stays on the PC.
- It would be a failure if the owner learned to ignore the note, or if an alert ever fired for something that could have waited.

## Slices

Each is usable on its own.

1. **Memory and the note.** The main PC's local service pushing state, the store, the measures, the two kinds of finding, the note and the charts. Observation only. Proven two ways: against fixtures taken from 2026-11-11's real records, which exist (the System log's sleep and wake events for F221, and the engine log's "No embedding endpoint answered" lines for the outage on port 9165), and then on one real night.
2. **The policy register.** The owner's standing rules in one file, read by the launcher and the engine, each with a guard.
3. **The alarm loop on the main PC**, one essential variable at a time, thermal first.
4. **The attention loop on the main PC**, in shadow and then live, covering registered apps, scheduled jobs, the chat engine's unload on request, and unregistered heavy software such as games.
5. **Allocation.** Advice first, then rules: wake only what a job needs, and send a job to the smallest box that can do it. The 4070 Ti Super box and the GTX box get their local parts here, which also brings them under the alarm loop.
6. **The look ahead.** A weekly page: what is trending toward a limit, what changed in how the system is used.

## Decisions for the owner

All five were answered on 2026-11-11: the owner approved the recommendation in each, and corrected the card in decision 1 to a GTX 1070 Ti.

1. **Which machine is always on.** Recommended: the doorman holds the always-on part and the GTX box is woken to help, because the doorman already never sleeps, already wakes the others, and should idle at a few watts where a desktop with a GTX card idles at several tens (typical figures for such machines; neither box has been measured). The alternative is the GTX box always on, doing all of it. The box is a GTX 1070 Ti (the owner, 2026-11-11), which is an 8 GB card; the earlier records that call it a 1080 Ti with 11 GB (`docs/decisions/2026-11-08-wakefulness-design.md`, the owner's `pc-wakefulness` notes) are wrong on that point.
2. **What counts as an intruder, and what closing the door means.** Proposed triggers: the pairing lock-out firing; a device joining the tailnet that was not there before; repeated refused management requests from a remote client; a failed-login burst on the doorman. Proposed response: the PC revokes every paired device and stops its HTTPS proxy, and the doorman answers only the main PC until the owner clears the alarm, since its wake and schedule routes are open to any tailnet device today. This cuts the owner's own phone off until they pair again at the desk.
3. **A scheduled job that is already running when the owner starts something heavy.** Recommended: it is interrupted and run again from the start once the owner is done, for jobs marked safe to repeat; other jobs finish while the owner's app is answered by the smaller model on the other box. The alternative is that a running job always finishes first.
4. **Shadow first, or live from the first day**, for the attention loop. Recommended: shadow, for as long as it takes the record to be clean.
5. **A page on the doorman's tailnet address** for the note and charts. It takes no input, but it is a new thing readable from the owner's other devices, so it needs their yes. Recommended: yes, bound to the tailnet address only, like the doorman itself.

## Calls made in this design that the owner did not make

- The attention loop and the reflexes run on the box that owns the GPU, in a service of their own, not on the watcher and not inside the engine.
- Boxes push their state; the watcher never asks a box for anything.
- Model requests alone never count as the owner's attention; a game is never made to yield.
- The always-on part is Python with the standard library, like the doorman.
- The watcher's core is deterministic; a language model only writes up.
- Answers and one-tap actions go through the CynCo dashboard; the doorman's page takes no input.
- Unanswered items rise in the note and never turn into alerts.
- Allocation is a fourth kind of authority that advises first.
- Disk and memory are on the list of essential variables beside the two the owner named.
- The engine's per-conversation governance is left alone.

## Left to the builder

The sampling beat; the store's schema; the exact form of the measures; how the owner's input and the foreground window are read on Windows and tied to a unit; how the local service is packaged; the chart library; the wording of the note; how many days of history a series needs before the filter speaks. The limits for each essential variable are not left to the builder: they come from the vendor's figures and the owner's answer to decision 2.

## Slice 1 as built (2026-11-12)

Built and proven against the records of 2026-11-11, and **live since 2026-11-12 04:40Z**: `watcher.service` on the doorman (listeners on `100.110.117.10` only: 9170, 9171, 8090) and the task "CynCo box reporter" on the main PC. On its first read of real data, at 04:41Z, the note said `main: awake since 21:40, last heard 25 s ago` and flagged the eight wakes of F221 from the PC's own System log, with the 10:11Z scheduled wake left out. The same note also flagged a silence that was not one, the 13.9 hours before the reporter existed (F232, fixed the same day: silence is only counted after a real report, and a stop the reporter announces is "not watched"). The second proof this design asks for, one real night, is the night of 2026-11-12. Where things are: the watcher `scripts/doorman/` (`CLAUDE.md` there), the main PC's reporter `engine/power/reporter/` (`engine/power/CLAUDE.md`), the go-live steps `docs/liveness-setup.md` § 8, what it left `docs/NOW.md`.

**What the owner can do afterwards.** Open `http://100.110.117.10:9171/` from any of their devices, with the PC asleep or awake, and read for any day: what was flagged (what was seen, what was expected, what the watcher believes it means, a suggested action in words), what is still learning, the measures, and per box a chart on one time axis (state, who held the GPU, each service, jobs, temperature) with the flagged times marked.

**Not built, by decision.** The owner's three answers to a finding (the first follow-up, `docs/NOW.md` says why it was left out whole), one-tap actions (not in this slice), the hand-off measure (it needs slice 4's switches), and "going to sleep" said ahead of the sleep.

**The builder's choices** ("Left to the builder" above), each a constant in one place:

| Choice | Value | Where |
|---|---|---|
| Sampling beat | a look every 15 s; a sample when the state fingerprint changed, else every 60 s | `engine/power/reporter/main.ts` |
| Store | SQLite, tables `samples` (box, at), `events` (box, kind, key), `meta`; samples kept 90 days | `scripts/doorman/watchstore.py` |
| A wake is behind a burst when | the burst for that box started between 120 s before and 5 s after the wake; or the owner's input is at the moment of the wake | `scripts/doorman/watchmodel.py` |
| Grace | a service down 180 s, a model unused 20 min, silence 300 s | same |
| History before the filter speaks | 12 readings over at least 3 days; window 30; outlier at 3 robust sigma; a step is 3 in a row; CUSUM slack 0.5, threshold 5 | same |
| Measures | asleep ÷ time nothing needed the box (idle 5 min and nothing open, or a stretch that ended in an idle sleep); unused ÷ loaded; answering ÷ wanted; runs ok ÷ runs | same |
| Charts | inline SVG written by hand, no library, no script | `scripts/doorman/watchnote.py` |
| The owner's input | `GetLastInputInfo` in the owner's session; the foreground window is not read (the attention loop's, slice 4) | `engine/power/reporter/idle.ts` |
| Packaging | a fifth scheduled task at logon, `bun engine\power\reporter\main.ts` | `scripts/run-box-reporter.cmd` |

The design's own example holds: over the four hours of F221 "asleep when it could be" reads 0.44 (112 minutes of 255); over that whole local day, with the first sleep and the stretch after the update's restart, 0.38.

**What the build added beyond the table in "What is reused and what is new"**, with the six questions:

| Added | Problem | Why the existing thing is not enough | State and failure it adds | Verified by | Disabled by | Maintained with |
|---|---|---|---|---|---|---|
| The doorman's burst journal (`/var/lib/doorman/bursts.jsonl`) | A wake can only be matched to a knock or a scheduled job if the doorman wrote down which it was | Its journal has the packets and not the cause, and only root reads it | One bounded file (rewritten to its newest half over 20,000 lines); a write that fails is logged and the wake still goes out | `test_doorman_bursts.py` | `doorman.record` left as the no-op | `scripts/doorman/` |
| `LOCALCODE_WATCHER_URL` | The reporter needs the watcher's address and a way to be off | No existing variable names the watcher | None; unset means nothing is gathered or sent | `reporter.test.ts`, the README inventory guard | Unset it, or do not register the task | `engine/power/` |
| The reporter's folder `~/.cynco/watch/` | A restart must not resend a day of logs or lose a backlog | Nothing else keeps a read position for the System log, the engine log or `runs.jsonl` | `state.json` (three positions) and `outbox.jsonl` (only while there is a backlog, at most 5,000 records); deleted, it starts from the end of each log | `reporter.test.ts` | Delete the folder | `engine/power/` |
| `activity` on `GET /api/session` | From outside the engine, a model in use and a model only loaded look the same | `activity.snapshot()` had no caller; `processing` covers a turn and not a lone model request | One more field on an existing answer, behind the same token | `reporter.test.ts` | Not reading it: an engine without the field gives `open: null` and use is "unknown" | `engine/power/` |
| The doorman's pytest files run by `npx vitest run` | Nothing ran the doorman's tests but a person (F230) | CI and the suite never started Python for them | A test that needs Python 3 and pytest, and says so and skips without them | Itself | Deleting the test file | `scripts/__tests__/` |

**Calls made in the build that the owner did not make**: sleep is read back after the wake, not announced; the wake source Windows names is shown and never taken as the answer; the port's holder is read without discovery, so an unregistered app reads as not CynCo's; `/push` has no authentication beyond the tailnet, as the doorman's routes; findings give times in UTC and the chart in local time; the answers are left out whole. Each with what it costs if wrong is in the build's report and in `docs/NOW.md`.

## Sources

- Stafford Beer, *Brain of the Firm* (1972); *Heart of Enterprise* (1979); *Diagnosing the System for Organizations* (1985).
- Stafford Beer, "The Viable System Model: its provenance, development, methodology and pathology", *Journal of the Operational Research Society* (1984). https://www.kybernetik.ch/dwn/Viable_System_Model.pdf (read this session).
- Stafford Beer, "Fanfare for Effective Freedom" (1973). https://www.kybernetik.ch/dwn/Fanfare_for_Freedom.pdf (read this session).
- P. J. Harrison and C. F. Stevens, "A Bayesian Approach to Short-term Forecasting", *Operational Research Quarterly* 22(4) (1971).
- W. Ross Ashby, *Design for a Brain* (1952); *An Introduction to Cybernetics* (1956). http://pespmc1.vub.ac.be/books/IntroCyb.pdf
- Roger C. Conant and W. Ross Ashby, "Every good regulator of a system must be a model of that system", *International Journal of Systems Science* 1(2) (1970).
- William T. Powers, *Behavior: The Control of Perception* (1973).
- Heinz von Foerster, "Cybernetics of Cybernetics" (1979); Gordon Pask, *Conversation Theory* (1976).
