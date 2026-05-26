# Cybernetics Library Integration + Dead Module Wiring

**Date:** 2026-05-26
**Status:** Approved
**Scope:** Replace hand-rolled governance internals with `@cybernetics/core`, wire three dead modules into S5

## Problem

The `@cybernetics/core` library is vendored at `engine/cybernetics-core/`. The governance modules in `engine/vsm/` import the library's *types* (AlgedonicSignal, KillSwitch, AshbyHomeostat, etc.) but hand-roll the *computational logic* around them — simplified heuristics instead of Beer's actual mathematics. The library's formal functions (regulatoryVariety(), measureRelaxation(), checkAxiom1(), isGoodRegulator(), findEigenform(), etc.) are never called.

Additionally, three governance modules are created and recording data but their outputs are dropped:
- **Heterarchy**: computes commander at line 337 of `cyberneticsGovernance.ts` but `heterarchyAuthority: null` is hardcoded in S5Input (conversationLoop.ts line 626)
- **Conversation Theory**: records exchanges at line 341 but agreement ratio is never queried
- **Observer Effects**: records measurements at lines 325-326 but divergence is never checked

## Approach: Adapter Swap

`CyberneticsGovernance`'s public API stays unchanged. ConversationLoop, S5, and the TUI never know the difference. Internally, each hand-rolled `*Integration` class gets its implementation replaced with `@cybernetics/core` calls.

The library is already available as `@cybernetics/core` (v0.1.0) at `engine/cybernetics-core/`. It exports:
- `variety`: VarietyEngine, Attenuator, Amplifier, Transducer, regulatoryVariety()
- `algedonic`: AlgedonicSignal, AlgedonicChannel, KillSwitch, SlaTracker, routeSignal()
- `homeostat`: AshbyHomeostat, TrendTracker, calculateBalance(), calculateMetasystem()
- `foundations`: FeedbackLoop, PidController, UltrastableSystem, entropy(), requisiteVariety()
- `metrics`: Achievement, CusumDetector, performanceIndicesFromAchievement()
- `autopoiesis`: Proposal, ProductionNetwork, StructuralCoupling, OrganizationalIdentity
- `constraints`: Trend, posiwidCheck(), checkAutonomy(), calculateFreedom()
- `heterarchy`: HeterarchyGraph, CommandRegistry
- `conversation`: EntailmentMesh, TeachbackProtocol, AgreementTracker, AgreementState
- `observer`: Measurement, MeasurementLog, findEigenform(), isStableEigenform()
- `events`: EventBus, DomainEvent (15 typed variants)
- `vsm`: VSMNode, ChannelSet, ChannelState, SystemInFocus, Environment, checkAxiom1/2/3(), checkPrinciple1/2/3/4()

## Migration Order

Each step is independently testable. External API of `CyberneticsGovernance` never changes.

### Step 1: Variety

**Current** (`cyberneticsGovernance.ts` lines 186, 318-321):
- Already uses `@cybernetics/core` VarietyEngine and VSMNode (these two were imported early)
- But variety calculation is simplified: `setInputCount(toolsCalled)`, `setActiveTheories(distinctTools)`

**Change:**
- Add Attenuators for variety reduction (profile-denied tools, context budget constraints)
- Add Amplifiers for variety expansion (sub-agent spawning, workflow phase tools)
- Use `regulatoryVariety()` for proper logarithmic scaling
- Use `varietyBalanceEquation()` for Beer's formal balance check
- **New behavioral effect:** Attenuator/Amplifier chain produces a more accurate variety ratio. Currently, variety just counts tools — with the library, it measures information-theoretic variety (Shannon entropy via `entropy()`) and regulatory capacity.

**Files:** `engine/vsm/cyberneticsGovernance.ts` (variety setup in constructor + onTurnComplete)

### Step 2: Algedonic

**Current** (`engine/vsm/algedonicIntegration.ts`):
- Already imports `AlgedonicSignal`, `AlgedonicChannel`, `KillSwitch`, `SlaTracker` from library
- Hand-rolls: signal creation (hardcoded scores 0.2/0.7), consecutive pain counting, kill threshold

**Change:**
- Use `AlgedonicChannel.emit()` routing actions instead of manual severity routing
- Use `classifySeverity(score)` for proper severity classification
- Use SLA response-time thresholds from library (Critical=1s, High=10s, Moderate=60s, Low=5min)
- Replace hardcoded `KILL_THRESHOLD = 5` with configurable parameter from EssentialVariableRegistry
- **New behavioral effect:** SLA tracking becomes formal. Tool latency violations create proper algedonic signals with severity-based routing, not just pain/pleasure binary.

**Files:** `engine/vsm/algedonicIntegration.ts`

### Step 3: Homeostat

**Current** (`engine/vsm/homeostatIntegration.ts`):
- Already imports `AshbyHomeostat`, `TrendTracker`, `calculateMetasystem` from library
- Hand-rolls: coupling weights (hardcoded -0.3, +0.2), stability threshold (0.05), ultrastability (random weight perturbation)

**Change:**
- Use library's `measureRelaxation()` for health checks instead of raw `isStable()`
- Use `timeConstantForLevel(level)` for Beer's system-level time constants instead of hardcoded `5.0`
- Use `classifyHomeostatBalance()` for formal S3/S4 balance classification
- Move coupling weights to EssentialVariableRegistry so they're tunable and logged
- **New behavioral effect:** Time constants vary by system level (S1 fast, S5 slow). Ultrastability perturbation uses proper parameter search from `UltrastableSystem` instead of random weight randomization.

**Files:** `engine/vsm/homeostatIntegration.ts`

### Step 4: Feedback Control

**Current** (`engine/vsm/feedbackControlIntegration.ts`):
- Already imports `FeedbackLoop`, `PidController`, `UltrastableSystem` from library
- Hand-rolls: setpoints (0.7, 0.8), PID gains (0.3, 0.05, 0.1), perturbation step (0.05)

**Change:**
- Use `classifyDamping()` to verify PID isn't oscillating (check zeta)
- Use `modelFidelity()` and `isGoodRegulator()` for Conant-Ashby theorem validation
- Move PID gains and setpoints to EssentialVariableRegistry
- Use library's `channelCapacity()` and `channelSufficient()` for Beer's 2nd Principle checks
- **New behavioral effect:** PID gains become tunable governance parameters. Conant-Ashby theorem check validates that the governance model is a good regulator of the system it controls. Channel sufficiency checks validate that the WebSocket bridge has enough capacity.

**Files:** `engine/vsm/feedbackControlIntegration.ts`

### Step 5: Performance Metrics

**Current** (`engine/vsm/performanceMetricsIntegration.ts`):
- Already imports `Achievement`, `CusumDetector` from library
- Hand-rolls: actuality/capability/potentiality estimates, health thresholds (0.3, 0.6)

**Change:**
- Use `performanceIndicesFromAchievement()` for Beer's formal productivity/latency/performance ratios
- Use `performanceHealth()` for composite health score
- Move health thresholds to EssentialVariableRegistry
- **New behavioral effect:** Performance indices become formal Beer metrics. Health thresholds are tunable.

**Files:** `engine/vsm/performanceMetricsIntegration.ts`

### Step 6: Heterarchy (Dead → Live)

**Current** (`engine/vsm/heterarchyIntegration.ts`):
- Already imports `HeterarchyGraph`, `CommandRegistry` from library
- Computes commander at line 337 of governance but **drops it** — S5Input gets `heterarchyAuthority: null`

**Change:**
- In `cyberneticsGovernance.ts`: store the computed commander in a field accessible via `getReport()` or a new getter
- In `conversationLoop.ts` (line 626): replace `heterarchyAuthority: null` with actual commander value from governance
- S5 rule I4 already exists to journal heterarchy changes — it will now receive real data
- Add new S5 rule: when heterarchy commander is S4 (exploration context), expand tool set. When S3 (routine), restrict to proven tools. When S5 (crisis), restrict to read-only.
- **New behavioral effect:** Authority actually shifts based on context. Stuck → S5 takes command (crisis tools only). Exploration → S4 commands (broad tool set). Routine → S3 commands (proven tools). This is emergent governance — the system self-organizes its tool permissions based on situational context.

**Files:**
- `engine/vsm/cyberneticsGovernance.ts` — expose commander
- `engine/bridge/conversationLoop.ts` — populate S5Input.heterarchyAuthority
- `engine/s5/ruleBasedS5.ts` — upgrade I4 from info to warning tier with behavioral effect

### Step 7: Conversation Theory (Dead → Live)

**Current** (`engine/vsm/conversationTheory.ts`):
- Already imports `TeachbackProtocol`, `AgreementTracker`, `EntailmentMesh` from library
- Records exchanges at line 341 of governance but **agreement ratio is never queried**

**Change:**
- In `cyberneticsGovernance.ts` `onTurnComplete()`: after `recordExchange()`, call `getAgreementRatio()`
  - If ratio < 0.5: emit algedonic pain signal (system and user are diverging)
  - Store ratio in governance report
- Add `agreementRatio: number` to GovernanceReport type
- Add `agreementRatio: number` to S5Input
- Add S5 rule: when agreementRatio < 0.4 for 3+ consecutive turns, recommend S2 clarification (inject "Let me make sure I understand your goal..." into next turn)
- Wire `checkPrerequisites()` into workflow engine: if a workflow phase has prerequisites, verify they're met before advancing
- **New behavioral effect:** Low agreement between user and system triggers a clarification nudge. The system notices when it's diverging from user intent — a real teachback protocol.

**Files:**
- `engine/vsm/conversationTheory.ts` — no change (already implemented)
- `engine/vsm/cyberneticsGovernance.ts` — query agreement ratio, emit pain if low
- `engine/vsm/types.ts` — add agreementRatio to GovernanceReport
- `engine/s5/types.ts` — add agreementRatio to S5Input
- `engine/s5/ruleBasedS5.ts` — add agreement rule
- `engine/bridge/conversationLoop.ts` — populate agreementRatio in S5Input

### Step 8: Observer Effects (Dead → Live)

**Current** (`engine/vsm/observerEffects.ts`):
- Already imports `Measurement`, `MeasurementLog` from library
- Records dual measurements (S3 and S4 perspectives) at lines 325-326 but **divergence is never checked**

**Change:**
- In `cyberneticsGovernance.ts` `onTurnComplete()`: after recording measurements, call `checkDivergence('success_rate', 0.2)`
  - If divergence exceeds threshold: emit algedonic signal, log to EventBus
  - Store divergence in governance report
- Add `observerDivergence: number | null` to GovernanceReport and S5Input
- Add S5 rule: when observerDivergence > 0.3 for 2+ turns, S5 arbitrates — weight the more conservative observer's measurement (S4's view includes context S3 doesn't have)
- Call `findSelfAssessmentEigenform()` at session end to check if the system's self-model converges
  - Non-convergent eigenform → flag session as "self-assessment unstable" in GovernanceDB
- **New behavioral effect:** When S3 (operations) and S4 (intelligence) disagree on how well things are going, S5 notices and arbitrates. This is second-order cybernetics — the system observes its own observation process.

**Files:**
- `engine/vsm/observerEffects.ts` — no change (already implemented)
- `engine/vsm/cyberneticsGovernance.ts` — check divergence, eigenform at session end
- `engine/vsm/types.ts` — add observerDivergence to GovernanceReport
- `engine/s5/types.ts` — add observerDivergence to S5Input
- `engine/s5/ruleBasedS5.ts` — add divergence arbitration rule
- `engine/bridge/conversationLoop.ts` — populate observerDivergence in S5Input

### Step 9: Autopoiesis + Constraints

**Current:**
- `autopoiesisIntegration.ts`: already imports `ProductionNetwork`, `StructuralCoupling`, `OrganizationalIdentity`, `Proposal` from library
- `constraintChecksIntegration.ts`: already imports `Trend` from library, uses `posiwidCheck()`, `checkAutonomy()`, `calculateFreedom()`

**Change:**
- These are already the most library-aligned modules. Clean up any remaining hand-rolled helpers.
- Use `isAutopoietic()` and `missingCriteria()` from library for formal Maturana & Varela assessment
- Use `ProductionNetwork.isClosed()` to verify organizational closure
- Ensure constraint violations emit proper `DomainEvent.autonomyViolation()` events
- **No new behavioral effects** — these modules are already functional, just needs cleanup.

**Files:** `engine/vsm/autopoiesisIntegration.ts`, `engine/vsm/constraintChecksIntegration.ts`

### Step 10: EventBus + VSM Axiom Checks

**Current:**
- EventBus from library is already used (line 137 of governance)
- VSM axiom/principle check functions are available but never called

**Change:**
- Add periodic axiom checks (every N turns, aligned with S4 reflection cycle):
  - `checkAxiom1()`: variety balance at each recursion level
  - `checkAxiom2()`: S5 has enough variety to arbitrate
  - `checkPrinciple1()`: management variety absorbs operational variety
  - `checkPrinciple2()`: channels have sufficient capacity
- Log axiom violations to EventBus and GovernanceDB
- Add axiom health to governance report (how many axioms hold)
- **New behavioral effect:** The system can report "Beer's Axiom 1 violated — operational variety exceeds management capacity" in governance status. This is formally verifiable cybernetics.

**Files:**
- `engine/vsm/cyberneticsGovernance.ts` — add axiom check cycle
- `engine/vsm/types.ts` — add axiomHealth to GovernanceReport

### Step 11: Dead Code Removal

Delete all hand-rolled implementations that are now replaced by library calls. Specifically:
- Any utility functions in `*Integration.ts` files that duplicate library functionality
- Any type definitions that duplicate library types
- Any test helpers that test removed code

**Rule:** If a function is now a one-line call to `@cybernetics/core`, delete the wrapper unless it adds meaningful adaptation logic.

### Step 12: Wire Check

Verify every integration point end-to-end:

- [ ] `@cybernetics/core` is imported in every `*Integration.ts` file that uses it
- [ ] `VarietyEngine` uses Attenuators and Amplifiers (not just setInputCount)
- [ ] `AlgedonicChannel.emit()` routing actions are used (not manual severity routing)
- [ ] `AshbyHomeostat` uses `timeConstantForLevel()` (not hardcoded 5.0)
- [ ] `heterarchyAuthority` in S5Input is populated from governance (not null)
- [ ] `agreementRatio` in S5Input is populated from conversation theory
- [ ] `observerDivergence` in S5Input is populated from observer effects
- [ ] S5 rules consume all three new signals (heterarchy, agreement, divergence)
- [ ] GovernanceReport includes `agreementRatio`, `observerDivergence`, `axiomHealth`
- [ ] Axiom checks run on S4 reflection cycle
- [ ] Eigenform check runs at session end
- [ ] All deleted hand-rolled code has no remaining importers (grep for removed exports)
- [ ] All tests pass after migration

## Files Changed Summary

| File | Nature of Change |
|------|-----------------|
| `engine/vsm/cyberneticsGovernance.ts` | Major: constructor setup, onTurnComplete, new getters, axiom checks, eigenform |
| `engine/vsm/algedonicIntegration.ts` | Medium: replace manual routing with library |
| `engine/vsm/homeostatIntegration.ts` | Medium: use proper time constants, measureRelaxation |
| `engine/vsm/feedbackControlIntegration.ts` | Medium: add Conant-Ashby, channel checks, tunable params |
| `engine/vsm/performanceMetricsIntegration.ts` | Small: use formal indices |
| `engine/vsm/autopoiesisIntegration.ts` | Small: use isClosed(), isAutopoietic() |
| `engine/vsm/constraintChecksIntegration.ts` | Small: cleanup |
| `engine/vsm/types.ts` | Small: add fields to GovernanceReport |
| `engine/s5/types.ts` | Small: add fields to S5Input |
| `engine/s5/ruleBasedS5.ts` | Medium: upgrade I4, add agreement + divergence rules |
| `engine/bridge/conversationLoop.ts` | Small: populate new S5Input fields |

## What Does NOT Change

- `CyberneticsGovernance` public method signatures
- ConversationLoop's usage of governance (getReport, onTurnComplete, checkOrHalt, etc.)
- S5Decision output format
- TUI protocol events
- Any TUI Python code
- Tool implementations
