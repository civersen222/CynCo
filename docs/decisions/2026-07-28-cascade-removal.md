# Remove `engine/cascade/` rather than wire it

**Date:** 2026-07-28
**Status:** Accepted
**Guard:** `engine/__tests__/guards/modelSwitchClaim.test.ts`

## What was there

`engine/cascade/modelPicker.ts` exported `classifyComplexity(message, recentToolCount)`,
a substring match over the user's wording returning `simple | moderate | complex`.
Its only non-test caller was `engine/main.ts`, the `/cascade` slash command, which
printed the classification and routed nothing.

README claimed: *"CynCo's S2 coordinator routes simple tasks to the fast model and
complex tasks to your primary."*

## What actually happens

Model switching is real, but it comes from elsewhere. S5 rule W2
(`engine/s5/ruleBasedS5.ts`) fires when `modelLatencyTrend === 'rising'`, at least
five turns have passed, and two or more models are configured; it proposes
`availableModels[1]`. `engine/bridge/conversationLoop.ts` then calls
`this.updateModel(decision.model)`.

The README claim was wrong about the system (S5, not S2), the trigger (measured
latency, not guessed complexity) and the moment (mid-session, not at dispatch).

## Decision

Delete `engine/cascade/`, delete `/cascade`, and correct the prose to describe W2.

## Rejected alternatives

**1. Wire `classifyComplexity` through `engine/engine/callModel.ts` as the README
describes.** Rejected: it creates a second routing authority. S5 sets
`decision.model` and the loop enforces it; a picker in `callModel` would overwrite
that every turn with no arbitration between them, and neither would know the other
existed. Making the README true would have made the system worse.

**2. Keep `/cascade` as a labelled diagnostic.** Rejected: a diagnostic is only
worth keeping if its output informs something. `classifyComplexity` feeds nothing,
so the reading is unfalsifiable — there is no behaviour it can be checked against.
Keeping it also keeps alive the idea that complexity routing is a thing CynCo does.

**3. Replace the keyword classifier with a better one and then wire it.** Rejected
on evidence, not effort: `S5Input.promptDifficulty` already exists, is fed from
`difficultyClassifier.getLevel()` in the conversation loop, and is derived from
observed turn telemetry. It is a measured signal. Swapping in a smarter guess at
dispatch time, before any evidence exists, is strictly worse than a measurement
taken after.

## Not recorded in the S5 decision journal

The instruction was to record these alternatives in the S5 decision journal. They
are here instead, on purpose. `~/.cynco/training/s5-decisions.jsonl` is a training
corpus of `(S5Input, S5Decision)` pairs written by the running engine; a
hand-authored architecture note has neither shape. `exportTrainingData.ts` would
silently drop it for lacking `input`/`decision`, so the record would be invisible
where it was filed and absent where it was wanted. The durable version of "this
can't rot again" is the guard test, which fails if the module returns or the prose
starts describing a router.
