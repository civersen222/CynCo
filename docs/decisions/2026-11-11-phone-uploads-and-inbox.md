# Files from the phone into a project, and an inbox for work done while the owner was away

**Date:** 2026-11-11
**Status:** Uploads and the inbox: accepted and built.
**Guard:** uploads: `engine/__tests__/projects/uploadHardening.test.ts`, `engine/__tests__/dashboard/requestBodyBound.test.ts`; the inbox: named in its section

## What was there

On 2026-10-05, in the projects-mode brainstorm, the owner decided the phone channel: "phone = a
dashboard page over Tailscale", uploads into a project, and an inbox. The decision was recorded
only as a line in `docs/NOW.md`. The page, the Tailscale listener and pairing were built first
(`2026-10-22-phone-access.md`); "phone files" on 2026-11-08 gave the chat an **Attach** button
that posts a photo or a document to `POST /api/projects/<slug>/knowledge`, the route the Projects
tab on the desk already used, and `.docx`/`.xlsx` extraction.

So the upload route existed and was reachable from a paired phone. It had been written for the
desk. Traced on 2026-11-11, it took three things on trust:

1. **That the extension says what the bytes are.** `holiday.jpg` holding HTML was written to
   `knowledge/`, recorded, journaled, handed to the image box and listed as a picture.
2. **That the path it writes is a file inside the project.** `writeFileSync(knowledge/<name>)`
   follows a link at that name, and follows `knowledge/` itself if that is a junction. The
   project folder is writable by the model (`gradeProjectCall` grades `ln -s` inside it as safe),
   which is why `engine/projects/CLAUDE.md` already calls the engine's own files there untrusted;
   the upload path had not been given the same treatment. `promoteArtifactApi` was worse in one
   direction: `statSync` follows links, so promoting an artifact that is a link copied whatever it
   pointed to, anywhere on this machine, into `knowledge/`, where the chat can search it.
3. **That a second file under a taken name is the same file again.** A phone's camera names the
   photo, not the owner (`image.jpg` every time on some phones), and a different photo replaced
   the first one's bytes under a record that kept describing the first.

And one thing about size: the handler checked `Content-Length` against 50 MB and checked the
bytes again after reading them, but a chunked body declares no length, so `req.formData()`
buffered whatever arrived. Measured under Bun 1.3.13: Bun's own `maxRequestBodySize` refuses a
declared oversize body and does not cover a chunked one; 60 MB chunked reached the handler.

## Decision: uploads

Checked before anything is written, in this order (`engine/projects/upload.ts`,
`addKnowledgeApi`):

- **The bytes are what the name says** (`contentFault`): pictures by signature, PDF by header,
  `.docx`/`.xlsx`/`.epub` by the zip they are, `.md`/`.txt` as UTF-8 with no NUL bytes. Otherwise
  415, in words the page already shows ("not added: …").
- **`knowledge/` really is a folder of this project** (`knowledgeAreaFault`, `realInside`): 409
  otherwise, naming nothing outside.
- **The name is a file name** (`safeStem`): `CON.md` lands as `con-file.md`.
- **A taken name** (`landingName`): a *photo* whose bytes differ from the file under its name is
  kept beside it (`image-2.jpg`); the same photo sent twice is one file (200, the record already
  there, `duplicate: true`). A *document* sent again under its name is its new version, as it
  always was: the owner chose that name, and the project's own git history keeps the old one.
- **The write never follows anything** (`writeBytesAtomic`): a fresh file under an unguessable
  name, renamed into place, so a link planted at the name is replaced. A folder at the name is
  refused, not removed.

`promoteArtifactApi` lands through the same two functions, and its source must itself be a
regular file whose real path is inside the project (`lstat`, `realInside`); a link is refused.

**One request is bounded before it is read** (`engine/dashboard/server.ts`):
`maxRequestBodySize: MAX_REQUEST_BODY_BYTES` (one upload plus its multipart framing), and a body
that carries `Transfer-Encoding` is refused with 411 on every route, before the token check
(`/api/pair` reads a body from a client that holds no token). Browsers and `fetch` declare a
length for strings, forms and files; `tailscale serve` forwards it.

## Rejected for uploads

**Quotas (files or megabytes per project, per device, in total).** The reference design the
2026-10-27 review compared against has them. Here a paired device is the owner's own and is, in
the phone-access record's words, "equivalent to a terminal on this machine": it can create
projects without limit, so a per-project cap bounds nothing, and a global one would be a rule the
owner trips over while filing photos. What a stolen device token can do is bounded by revoking
it. Revisit if a second person ever holds a device.

**A separate, stricter route for the phone.** The desk and the phone post the same bytes to the
same folder; two routes would be two sets of rules to keep equal.

**Suffixing every taken name.** For documents it would turn "here is the corrected plan" into two
plans, both searched.

**Reading the upload as a stream to enforce the cap mid-body.** More code than refusing the one
framing nothing legitimate uses.

## Cost if wrong

A file whose content the rules do not recognise as its extension is refused where it used to be
kept unindexed; the page says why. A camera that names two different photos alike now yields two
files where it yielded one. A client that streams a body without a length gets 411; none of the
engine's own clients do (the page, `scripts/project-chat-drive.mjs`, the widget).

## Decision: the inbox

**Status:** accepted and built 2026-11-11.
**Guard:** `engine/__tests__/projects/inbox.test.ts`, `inboxFromRun.test.ts`, `engine/__tests__/dashboard/inboxRoutes.test.ts`, `inboxView.test.ts`

The 2026-10-05 line said only: an inbox where away-time work lands as drafts the owner accepts.
What existed before designing: every project has had an empty `inbox/` folder since projects
mode (`createProject` makes it; nothing read or wrote it); the daemon runs scheduled one-shots
and reports each as a summary (the phone's Away tab, ntfy) and as recommendations approved by a
tap; a trigger already takes a `cwd`. What did not exist: anywhere for the *work itself* to go.
A one-shot's answer was read for its outcome block and dropped.

Three questions, answered as small as is still real:

- **What counts as away-time work.** The answer of a scheduled run whose working folder is a
  project folder. A trigger is aimed at a project with the `cwd` it already has; no new field,
  no new kind of mission. A run anywhere else files nothing and reports as it always did. A chat
  the owner is in is not away-time work: its saves ask for consent in the turn.
- **Where a draft lives.** `<project>/inbox/<utc stamp>-<trigger>.md`: a plain file, the work
  and nothing else, with a record beside it (`inbox/.meta/<name>.json`: when, which mission and
  trigger, the run's one-paragraph summary). The folder is the truth, not an index: a file put
  there by hand or by a script is a draft too ("put here by hand"), and one record per draft
  means the two processes that touch an inbox, the one-shot that files and the engine whose page
  accepts, never rewrite a file they share. A draft is not indexed and the chat does not search
  it: until the owner accepts it, it changes nothing a chat says.
- **What accepting does.** The draft becomes an artifact: the checks an upload meets (an
  accepted extension, bytes that are what the name says, a write that follows nothing), a name of
  its own if an artifact already has that one, then the ordinary artifact path (indexed,
  journaled, committed to the project's history) and the draft leaves the inbox. Discarding
  deletes it. Both are the owner's act on the page, at the scope every project route has, so the
  phone can do them.

**Where the owner meets it.** A project's **Inbox** tab (the count is on the tab), a count on
the project list, and "Drafts waiting: Yard (2)" at the top of the phone's Away tab, above the
run summaries that were already there.

**Bounds.** 200 drafts per inbox; past that a run's work is not filed and its log says so (an
unattended trigger must not be able to fill the disk), and the tab says the inbox is full. One
draft keeps a million characters and says where it was cut. The page reads the first 256 KB of a
text draft.

**What it adds.** `engine/projects/inbox.ts`; four routes under `/api/projects/<slug>/inbox`;
`drafts` on each entry of `GET /api/projects`; three journal events (`draft.added`,
`draft.accepted`, `draft.discarded`) and one file origin (`draft`); two small additions in
`engine/daemon/oneShot.ts` (an `onFinished` callback on the success path, and the call). No
process, variable, protocol frame or dependency. Removed by deleting `inbox.ts`, the routes and
the callback: `inbox/` goes back to being an empty folder.

### Rejected for the inbox

**A draft store outside the project** (`~/.cynco/inbox`). A draft belongs to one project and
should move, back up and be deleted with its folder.

**An index file for the inbox**, like `knowledge/index.json`. Two processes would read, change
and write it; and a file dropped in by hand would be invisible until something rescanned.

**Filing every one-shot's answer**, wherever it ran. The fantasy digests and runbook passes
already land where the owner reads them (ntfy, the Away tab); a second copy in some default
project would be noise the owner has to discard.

**A `SaveDraft` tool for the model.** It would make "is this a draft?" the model's call, turn
by turn. The rule here is mechanical: this run was unattended and it was in a project.

**Accepting into knowledge.** Knowledge is what the owner brought; an artifact is what CynCo
made. Promote, which was already there, is the step from one to the other.

### Cost if wrong, and what is still thin

A one-shot in a project folder is the coding loop with that folder as its workspace, not a
project chat: it has the tools the trigger allows (read-only by default) and no project
retrieval. It can read the project's files; it does not get the `[Project knowledge]` block. So
the first drafts will be as good as a prompt that tells the run what to read. A project-bound
one-shot is the next step and is in `docs/NOW.md`. A trigger's `cwd` must be the project folder
itself; a folder inside it files nothing, which is easy to get wrong once.

## Verification

Inbox: Vitest (the four guard files). With `CYNCO_INTEGRATION=1`, a task file run through the
real conversation loop with a scripted model files its answer in the project and writes its
outcome; the same run elsewhere files nothing. In a browser against the dashboard server alone
on 19161: three drafts listed newest first, one read as text (`<script>` in it shown, not run),
one accepted (it appeared under Artifacts, indexed), one discarded, the counts on the tab, the
project list and the Away tab moving with them, no horizontal overflow at 375 px. Not run: a
trigger on the live daemon; `docs/liveness-setup.md` has the mission file for it.

Uploads: Vitest, the two guard files, plus the existing project, route and vision suites. Three of the
link tests need a file symlink, which this Windows account cannot create; they run on Linux and
are skipped here, the junction tests run on both. Under real Bun: a declared 60 MB body is
refused by Bun, a chunked 60 MB body gets 411, a 49 MB body reaches the handler.
