/**
 * Conversation Theory Integration — Pask's teachback + agreement tracking.
 *
 * Behavioral effects:
 * - Low agreementRatio → S2 coordinator suggests rephrase/clarify
 * - Divergent teachbacks → S4 explores alternative interpretations
 * - EntailmentMesh prevents out-of-order task execution
 * - Agreement depth tracked per conversation for quality metrics
 */

import { conversation } from '../cybernetics-core/src/index.js'

export class ConversationTheoryIntegration {
  readonly teachback: InstanceType<typeof conversation.TeachbackProtocol>
  readonly agreement: InstanceType<typeof conversation.AgreementTracker>
  readonly mesh: InstanceType<typeof conversation.EntailmentMesh>

  constructor() {
    this.teachback = new conversation.TeachbackProtocol()
    this.agreement = new conversation.AgreementTracker()
    this.mesh = new conversation.EntailmentMesh()
  }

  /**
   * Record a user message as a teachback verification attempt.
   * If the user rephrases their question or says "what?", that's a failed teachback.
   *
   * BEHAVIORAL EFFECT: low agreement triggers S2 to suggest rephrasing.
   */
  recordExchange(
    topic: string,
    systemExplanation: string,
    userResponse: string,
  ): void {
    const exchange = new conversation.TeachbackExchange(
      topic, 'system', 'user', systemExplanation,
    )
    exchange.recordTeachback(userResponse)

    // Heuristic: if user asks a question or says confused words, it's divergent
    const confused = /\b(what|huh|don't understand|confused|unclear|wrong|no)\b/i.test(userResponse)
    const confirmed = /\b(yes|ok|got it|thanks|perfect|good|right)\b/i.test(userResponse)

    if (confused) {
      exchange.verify(false) // divergent
    } else if (confirmed) {
      exchange.verify(true) // verified
    }
    // else: pending (no clear signal)

    this.teachback.addExchange(exchange)

    // Update agreement level for this topic
    const state = new conversation.AgreementState(topic, 'system', 'user')
    if (confirmed) {
      state.advanceTo(conversation.AgreementLevel.MutualUnderstanding)
    } else if (confused) {
      state.advanceTo(conversation.AgreementLevel.SharedTopics) // they know the topic, but not aligned
    } else {
      state.advanceTo(conversation.AgreementLevel.SharedProcedures) // working on it
    }
    this.agreement.add(state)
  }

  /**
   * Add a task prerequisite to the entailment mesh.
   * E.g., "testing" requires "implementation" which requires "design".
   *
   * BEHAVIORAL EFFECT: prevents out-of-order task execution.
   */
  addPrerequisite(task: string, requiresTask: string): void {
    this.mesh.addTopic(task, task)
    this.mesh.addTopic(requiresTask, requiresTask)
    this.mesh.addEntailment(task, requiresTask)
  }

  /**
   * Check if a task's prerequisites are met.
   * Returns unmet prerequisites.
   */
  checkPrerequisites(task: string, completedTasks: Set<string>): string[] {
    const prereqs = this.mesh.allPrerequisites(task)
    return Array.from(prereqs).filter(p => !completedTasks.has(p))
  }

  /**
   * Get overall agreement ratio (0-1). Lower = more miscommunication.
   *
   * BEHAVIORAL EFFECT: below 0.5 → S2 coordinator fires.
   */
  getAgreementRatio(): number {
    return this.teachback.agreementRatio()
  }

  /**
   * Get average agreement depth (0-4). Higher = deeper mutual understanding.
   */
  getAgreementDepth(): number {
    return this.agreement.averageDepth()
  }

  /**
   * Count of divergent exchanges (failed teachbacks).
   */
  getDivergentCount(): number {
    return this.teachback.divergentCount()
  }
}
