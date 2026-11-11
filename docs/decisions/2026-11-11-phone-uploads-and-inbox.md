# Files from the phone into a project, and an inbox for work done while the owner was away

**Date:** 2026-11-11
**Status:** Uploads: accepted and built. Inbox: see the section of that name.
**Guard:** `engine/__tests__/projects/uploadHardening.test.ts`, `engine/__tests__/dashboard/requestBodyBound.test.ts`

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

## Verification

Vitest: the two guard files, plus the existing project, route and vision suites. Three of the
link tests need a file symlink, which this Windows account cannot create; they run on Linux and
are skipped here, the junction tests run on both. Under real Bun: a declared 60 MB body is
refused by Bun, a chunked 60 MB body gets 411, a 49 MB body reaches the handler.
