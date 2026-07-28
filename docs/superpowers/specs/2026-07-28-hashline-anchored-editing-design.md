# Hashline: Anchored Editing — Design

**Status:** approved design, not yet planned
**Date:** 2026-07-28
**Prior art:** `can1357/oh-my-pi`, `packages/hashline` (MIT). Read at commit `main`, 2026-07-28.

---

## 1. The problem, in our own code

Four tools attack one problem, and the reason is legible in the code.

`engine/tools/impl/edit.ts` matches an exact `old_string`. It fails in two ways: the
string is not found, or it is found more than once. Between those two failures sits
`nearMissWindow()` — a function whose entire job is to explain to the model that it
almost retyped the file correctly. The tool spends `:96-103` and `:135-138` normalizing
line endings by hand so that matching survives CRLF.

`engine/tools/impl/multiEdit.ts` (62 lines) is the same thing batched.

`engine/tools/impl/replaceFunction.ts` (176 lines) states its own motivation in its doc
comment: it "handles the case where the model knows WHAT function to replace but can't
hold the exact 50-line old_string in memory." It carries language-specific heuristics for
Python `def`, TypeScript `function`, `const =`, and class methods.

`engine/tools/impl/applyPatch.ts` shells out to `git apply` on a unified diff, which needs
exact context lines — the same brittleness, plus hunk offsets.

A fifth attempt already failed. `edit.ts:107-109`:

```
// Semantic merge DISABLED — it corrupts files when the local model
// produces garbled output. Better to fail cleanly so the model retries
// with correct old_string, or uses ReplaceFunction for large edits.
```

The common cause is that every one of these tools requires the model to **reproduce text
it has already read**. A 27B local model is worse at that than the frontier models these
tools were designed around, and we have been treating it as a prompting problem.

**The substrate for the fix already exists.** `read.ts:43` emits `${offset + i + 1}\t${line}`.
The model sees a line number on every line of every read and has no way to address one.

---

## 2. What we are building

A new tool, `HashEdit`, that addresses lines by number against a content-tagged snapshot
of the file. The model never retypes existing content; it names a line range and supplies
only the replacement.

```
[engine/foo.ts#3C4D91AF]
SWAP 12.=18:
+  const parsed = JSON.parse(raw)
+  return parsed.value
DEL 24.=24
INS.POST 30:
+  logger.debug('done')
```

The `#TAG` is a content hash of the whole normalized file, minted by `Read` and quoted
back by the model. It certifies that the line numbers refer to the file as the model saw
it.

### Design decisions and their reasons

**1-based, ranges inclusive.** Matches `read.ts`'s existing numbering, so no translation
layer. `SWAP 12.=18` consumes line 18.

**All line numbers refer to the ORIGINAL file and never shift.** Multiple operations in
one call all address the pre-edit snapshot; the implementation applies them bottom-up so
earlier indices stay valid. The alternative — numbers that shift as operations apply — is
the single most reliable way to make a multi-op patch unwritable by a model that cannot do
arithmetic reliably.

**Every applied edit mints a fresh tag.** The success result carries the new
`[path#TAG]` and the affected line range renumbered, so a follow-up edit can anchor on the
edit response without a second `Read`.

**Body rows are final content, `+`-prefixed.** No `-old` rows, no context lines. There is
exactly one row kind, so there is nothing to get wrong. A literal line beginning with `-`
or `+` still takes the prefix: Markdown `- item` is written `+- item`.

**Ranges cover only lines that change.** A pure insertion uses `INS`, never a widened
`SWAP` that retypes keepers — retyped keepers are exactly what gets dropped.

---

## 3. Scope of the first pass

**In:**

| Operation | Meaning |
| --- | --- |
| `SWAP A.=B:` | replace original lines A through B (inclusive) with the body |
| `DEL A.=B` | delete original lines A through B. No body. |
| `INS.PRE A:` | insert the body immediately before line A |
| `INS.POST A:` | insert the body immediately after line A |
| `INS.HEAD:` | insert the body at the very start of the file |
| `INS.TAIL:` | insert the body at the very end of the file |

One file per call. All operations preflighted — parsed, bounds-checked, and applied in
memory — before anything is written.

**Out, and why:**

- **`SWAP.BLK` / `DEL.BLK` / `INS.BLK.POST`.** These resolve a syntactic block's closing
  line, which upstream does with tree-sitter (`block.ts`, 225 lines plus a grammar
  dependency per language). That is `ReplaceFunction`'s heuristics in a better coat, and it
  is the single largest cut available. Deferred until the benchmark says line ranges are
  insufficient for large edits.
- **`MV` / `REM`.** `Bash` and `git` already move and delete files. Adding a second way is
  surface area with no new capability.
- **`*** Begin Patch` / `*** End Patch` envelope.** Optional upstream; one file per call
  makes it pure ceremony.
- **Three-way recovery on tag mismatch.** See §5.
- **Boundary-repair heuristics.** See §9 — this is the known risk, deliberately taken.

---

## 4. The tag

Computed over the **whole file**, not the read window:

1. Strip BOM.
2. Normalize line endings to `\n`.
3. Trim trailing `[ \t\r]` from each line.
4. Hash. Render as **8 uppercase hex characters.**

Step 3 is upstream's and is worth keeping: it means whitespace that a display trims does
not invalidate a tag.

**Eight hex, not four.** Upstream uses 16 bits and accepts collisions, mitigating them by
storing full snapshot text and deduplicating on text equality rather than tag equality.
Our staleness check is a direct hash comparison with no snapshot to fall back on (§5), so
a collision is a silent false accept — the model edits line 40 of a file that changed under
it and we apply the edit. At 16 bits that is 1 in 65,536 per edit; at 32 bits it is 1 in
4.3 billion. Four extra characters per read is not a budget we need to defend.

---

## 5. Staleness

**Detection needs no snapshot store.** At edit time, read the file from disk, normalize,
hash, and compare to the tag the model quoted. Equal means the model's line numbers are
valid. This is the whole mechanism.

A snapshot store is required only for *recovery* — replaying the intended edit against a
file that has since changed. Upstream's `recovery.ts` is 288 self-contained lines that
diff the stale snapshot against live text, remap anchors across unchanged runs, require
**all anchors to shift by one identical offset**, and otherwise fail closed. It is not the
three-way merge the README advertises.

**First pass: detection only.** A stale tag is a hard failure whose error carries a fresh
numbered window of the affected range plus the new tag, so the model re-anchors from the
error instead of re-reading the file. This follows the pattern already established for
failed `Edit` calls (finding (g)).

Recovery is a candidate follow-on, gated on the benchmark showing stale tags are a
material share of failures rather than a rounding error.

---

## 6. `seenLines`

`read.ts` returns a **slice** — `lines.slice(offset, offset + limit)`. Those bounds are a
record of which lines the model was actually shown.

`HashEdit` rejects any anchor on a line the current session's reads never displayed, and
the rejection reveals the real content of those lines. A model that guesses at line 400 of
a file it read the first 200 lines of gets told so, with the text it was missing.

This is cheap — the slice bounds already exist and only need recording — and it addresses a
failure mode orthogonal to anchoring: not "the model retyped the line wrong" but "the model
never saw the line." For a 27B model that is plausibly the larger of the two.

**Storage:** a per-path set of displayed line ranges, accumulated across reads within a
session. It must survive compaction the way `FileOperationTracker`
(`engine/context/compressor.ts:25-39`) does, via the same serialize/deserialize path — a
tracker that resets on compaction reads as "you have seen nothing," which was finding (i).

**Escape hatch:** a full-file read (no `offset`/`limit`) marks the whole file seen. A file
`HashEdit` itself just wrote is fully seen, since the tool knows the resulting content.

---

## 7. Changes to `Read`

`read.ts:38-43` currently does this:

```ts
const content = readFileSync(filePath, 'utf-8')
const lines = content.split('\n')
```

It splits on `\n` with **no CRLF normalization**. On this repo every line therefore carries
a trailing `\r` into the model's context. That is a live defect independent of this work,
and it is fixed here because the tag depends on it.

`Read` will:

1. Normalize BOM and line endings before splitting.
2. Compute the tag over the whole normalized file.
3. Emit `[path#TAG]` as the first line of its output, above the numbered rows.
4. Record the displayed range for `seenLines`.

**Known landmine:** `engine/__tests__/tools/read.test.ts:41` asserts
`expect(result.output).not.toContain('d')` against a five-line fixture. Any hex tag
containing `D` breaks it. The assertion is testing "the slice stopped before line 4" and
should be rewritten to check the numbered rows, not the whole output.

The row separator stays `\t`. Upstream uses `LINE:TEXT`; ours is `LINE\tTEXT` and there is
no reason to churn it, but the prompt examples must show the format we actually emit.

---

## 8. Migration

### Why a separate tool, not a mode on `Edit`

The alternative considered was keeping the name `Edit` and adding line-anchored parameters
to its schema, selecting between them with a flag. Its only advantage was avoiding churn at
the sites that name `Edit` by literal — and that churn turns out to be small and mostly
worth doing anyway. A schema union is permanent ugliness the model sees every turn; the
churn is a one-time fix. So: a separate tool with a clean schema.

### The actual surface

Ten sites in eight non-test files name `'Edit'`. They are not one kind of thing:

**Allowlists (4)** — `engine/agents/types.ts:123`, `engine/skills/types.ts:36`,
`engine/workflows/definitions/tdd.ts:12,26`. Add a name.

**Mutation-set membership (2)** — `engine/bridge/toolFloor.ts:50` is inside the
`FILE_MUTATION_TOOLS` constant, which is the right shape. `engine/vsm/ablationRunner.ts:42`
is an ad-hoc `block.name === 'Edit' || block.name === 'Write'` that should have been using
it.

**Input-shape readers (3)** — `engine/bridge/conversationLoop.ts:112` builds a diff preview
from `input.old_string`/`input.new_string`; `engine/vsm/groundingTrigger.ts:18,30` pull
added text and target paths. Adding a name to a list does nothing for these.

`groundingTrigger.ts` already has the right abstraction —
`extractAddedText(toolName, input)` and `extractTargetPaths(toolName, input)` — it is just
not shared. `conversationLoop.ts:112` reimplements the same knowledge inline.

**Prep commit:** hoist those two accessors to a shared module, add a third for the diff
preview, point `conversationLoop.ts:112` at it, and fold `ablationRunner.ts:42` into
`FILE_MUTATION_TOOLS`. After that, registering a new edit tool is a line in a list.

### The A/B lever

`engine/tools/registry.ts` already partitions on a `core` flag —
`getCoreTools()` filters `t.core`, `getExtendedTools()` filters `!t.core`. Only core tools
are surfaced to the model up front.

One env var (`LOCALCODE_EDIT_VARIANT`, default `edit`) decides which of `Edit` and
`HashEdit` is core. **The model only ever sees one edit format, and the prompt only ever
teaches one.** This is upstream's `PI_EDIT_VARIANT` mechanism with real separate tools
instead of a schema union, and it is the same lever for the benchmark, for rollback, and
for the eventual default flip.

### Prompt

`engine/engine/systemPromptText.ts` has four `old_string` passages. They become
variant-conditional in the same commit that adds the tool. A new edit format the prompt
does not teach is worse than no new format.

---

## 9. `ReplaceFunction`

Line ranges subsume it *in principle*: `SWAP 120.=171:` needs only the function's span,
which numbered `Read` and `grep -n` already provide. But 176 lines of it also **locate** the
function by name across four languages, which line ranges do not do.

**It is not deleted in this work.** It is carried as a third arm in the benchmark on the
large-edit subset, and deleted only if `HashEdit` beats it there. Deleting a tool on the
argument that a new one *should* subsume it is precisely what produced the dead
`semanticMerge.ts` this design also cleans up.

---

## 10. Dead code removed

Verified against the current tree, not the comment history:

- `engine/tools/semanticMerge.ts` (19 lines) exports `attemptSemanticMerge`.
- `edit.ts:4` imports it. **It is never called anywhere in `engine/`.**
- `edit.ts:15` declares `_sideQuery`; `edit.ts:19` writes it. **It is never read.**
  `setSideQuery` is imported at `conversationLoop.ts:75` and **never called.**
- `edit.ts:7` declares `mergeAttemptedFiles`; `resetMergeTracking()` clears it from
  `conversationLoop.ts:1936`. **It is never read.**

Only `engine/__tests__/semanticMerge.test.ts` and
`engine/__tests__/integration/e2e-smallcode-features.ts:280-285` still exercise the module,
so the suite stays green while the feature does nothing.

Remove the module, its tests, the two integration assertions, and the dead wiring. Record
it in `DEAD_CODE_AUDIT.md`.

This lands as its own commit, first, because it makes `edit.ts` readable before anything
else touches it.

---

## 11. Benchmark

Edit-strategy quality is measured, not asserted. If `HashEdit` does not beat `Edit`, we do
not carry two tools.

**Location:** `benchmark/edit/`. (`benchmark/true/` is the existing polyglot harness; this
reuses its statistics but not its task shape.)

**Corpus.** Real hunks from our own git history (1053 available across `localcode` and
`civkings`), inverted: check out the parent revision of the file, prompt in natural language
for the change the commit made, expect the post-commit file.

**Stratification is by anchor ambiguity, not hunk size.** Upstream's generator states the
reason directly:

> The goal is testing edit precision, not bug-finding ability. The mutation can be trivial —
> what matters is whether the model can surgically apply the patch in difficult contexts:
> Repeated lines / Long files / Similar blocks / Dense code / Deep nesting.

Their tiers run `easy` (short file, unique lines, line number given) to `nightmare` (long
file, target line text repeats, minimal information). Hunk size and language are close to
irrelevant next to this, and ambiguity is the exact axis on which line-anchoring should beat
string-matching. Four bins, assigned mechanically per task from measurable properties:

| Bin | Occurrences of the target line's text | File length | Location hint in prompt |
| --- | --- | --- | --- |
| easy | 1 | < 100 lines | line number given |
| medium | 1 | 100–500 | function name given |
| hard | 1 | > 500 | none |
| nightmare | > 1 | > 500 | none |

**Pass criterion: byte-for-byte equality** of the resulting file against the post-commit
file. Not upstream's criterion — `verify.ts` normalizes whitespace and runs Prettier on both
sides before comparing, contradicting its own doc comment, which claims byte equality. Two
reasons to diverge: we cannot Prettier Python or Markdown, and formatting-tolerant
comparison would let `HashEdit` pass on a whitespace error that anchored editing exists to
prevent. Indent distance is **reported alongside** as a descriptive metric, so a
near-miss is visible without being forgiven.

**Statistic.** Paired — same task, same seed, both arms — via `pairedBootstrapLift` in
`benchmark/true/harness/stats.ts`, 95% CI.

Three possible verdicts, all of them acceptable outcomes:

- CI lower bound > 0 → `HashEdit` wins. Flip the default, plan `ReplaceFunction`'s removal.
- CI straddles 0 → **no measured difference.** Do not carry two tools. `HashEdit` is
  deleted, and this document records why.
- CI upper bound < 0 → `HashEdit` loses. Deleted, with the failure breakdown kept.

**Also reported, descriptive not gating:** per-call edit success rate (a call that applied
cleanly, whether or not the task succeeded — upstream shows these two decorrelate strongly,
which is the useful signal), tool input characters (the "never retypes `old_string`" claim,
measured rather than assumed), wall milliseconds, and a failure breakdown by cause.

**The failure breakdown is load-bearing**, because of §12 below. Categories: stale tag,
anchor never seen, out-of-bounds line, off-by-one boundary, wrong content. Without it we
cannot distinguish "anchored editing is worse" from "anchored editing minus its
error-absorption is worse."

**Cost.** At p ≈ 0.6 paired, detecting a 10-point lift needs on the order of 150 tasks. At
roughly 60 s per task per arm, that is about five hours of GPU for two arms, more with the
`ReplaceFunction` arm on the large-edit subset. This is the real price of the measurement
and is stated here so it is not a surprise.

---

## 12. Known risk

Upstream's `apply.ts` is 1331 lines, of which the majority is
`repairReplacementBoundaries` and `repairAfterInsertLandings` — heuristics that absorb
off-by-one keeper lines and duplicated closing delimiters. The essential apply loop is
roughly 250 lines.

**We ship without them, and that is the most likely way this fails.** A model that says
`SWAP 12.=18` when it meant `12.=17` produces a deleted keeper line rather than an error.
The heuristics exist because that is the common mistake.

This is a deliberate order of operations, not an oversight: shipping the repairs first
would mean we could never tell whether the format or the repairs earned the result. The
failure breakdown in §11 makes "off-by-one boundary" a counted category. If it dominates,
porting the boundary repair is a scoped follow-on with a number attached to it.

---

## 13. Complexity budget

Upstream `src` totals ~4,850 lines. Our first pass, with `.BLK`, recovery, `MV`/`REM`,
fence-stripping, and boundary repair all cut, is estimated at **600–800 lines**: tag and
header formatting, normalization, a tokenizer and parser for six operations, the bottom-up
apply loop, and the seen-lines tracker.

---

## 14. Commit sequence

Each commit leaves `bun run test` green.

1. **`chore:`** remove dead `semanticMerge` — module, tests, integration assertions, dead
   wiring in `edit.ts` and `conversationLoop.ts`; note in `DEAD_CODE_AUDIT.md`.
2. **`refactor:`** centralize edit-tool identity — shared accessors for added text, target
   paths, and diff preview; `ablationRunner.ts:42` folded into `FILE_MUTATION_TOOLS`.
3. **`feat:`** `Read` normalizes BOM and line endings, emits `[path#TAG]`, records the
   displayed range; `read.test.ts:41` rewritten.
4. **`feat:`** `HashEdit` — six operations, original-line numbering, bottom-up apply,
   preflight-then-commit, staleness detection, `seenLines` rejection. Registered
   non-core; `LOCALCODE_EDIT_VARIANT` selects which edit tool is core;
   `systemPromptText.ts` teaches the selected variant.
5. **`bench:`** the paired A/B harness, corpus generator, and ambiguity binning. Run it.
6. **Gate.** Flip the default, or delete `HashEdit` and record the measurement here.
   `ReplaceFunction`'s verdict lands with it.

---

## 15. Constraints this design must not violate

- **The append-only prompt prefix.** Guard:
  `engine/__tests__/engine/prefixStability.test.ts`. `LOCALCODE_EDIT_VARIANT` is read once
  at startup and the prompt is built from it; it is never switched mid-session.
- **`bun run test` green before each commit.** Known-good baseline is 2 failed files /
  8 failed tests (`skills/workflowParity.test.ts` ×7,
  `benchmark/true/polyglot/exercise.test.ts` ×1). Do not chase those.
- **`bun run audit:wiring`** must pass — a new tool that is registered but unwired is
  exactly what those guards exist to catch.
- **If a README claim and the code disagree, fix one or the other in the same commit.**
  This design already names two such disagreements: upstream's `verify.ts` doc comment
  (theirs, not ours to fix) and `read.ts`'s unnormalized line endings (ours, fixed in
  commit 3).
