/**
 * Autopoiesis Integration — self-modification governance.
 *
 * Controls HOW the system changes itself:
 * - ProductionNetwork: verify organizational closure
 * - Proposal: ALL self-modification goes through state machine
 * - StructuralCoupling: track co-drift between user and system
 * - OrganizationalIdentity: invariants that must be preserved
 *
 * Behavioral effects:
 * - No parameter change happens without a Proposal that passes identity checks
 * - Structural coupling score is emitted — dropping coupling triggers S4
 * - Unproduced components flagged as system dependency gaps
 */

import { autopoiesis, NodeId, Timestamp, ModificationType } from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events } from '../cybernetics-core/src/index.js'

export class AutopoiesisIntegration {
  readonly productionNetwork: InstanceType<typeof autopoiesis.ProductionNetwork>
  readonly coupling: InstanceType<typeof autopoiesis.StructuralCoupling>
  readonly identity: InstanceType<typeof autopoiesis.OrganizationalIdentity>
  private proposalLog: InstanceType<typeof autopoiesis.Proposal>[] = []
  private nodeId: InstanceType<typeof NodeId>

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId

    // Production network: model LocalCode's components
    this.productionNetwork = new autopoiesis.ProductionNetwork()
    const toolsIdx = this.productionNetwork.addComponent('tools')
    const contextIdx = this.productionNetwork.addComponent('context')
    const modelIdx = this.productionNetwork.addComponent('model_output')
    const governanceIdx = this.productionNetwork.addComponent('governance')
    // Tools produce outputs → feed context → model produces tool calls → governance monitors
    this.productionNetwork.addProduction(toolsIdx, contextIdx)
    this.productionNetwork.addProduction(contextIdx, modelIdx)
    this.productionNetwork.addProduction(modelIdx, toolsIdx)
    this.productionNetwork.addProduction(governanceIdx, toolsIdx) // governance adjusts tools
    this.productionNetwork.addProduction(modelIdx, governanceIdx) // model feeds governance

    // Structural coupling: track interaction between user and system
    this.coupling = new autopoiesis.StructuralCoupling()

    // Organizational identity: invariants that must be preserved
    this.identity = new autopoiesis.OrganizationalIdentity(
      'LocalCode',
      [
        'tool_approval_required',
        'context_budget_enforced',
        'variety_balance_maintained',
        'algedonic_channel_active',
        'session_continuity_preserved',
      ],
    )
    // Set initial structure matching all invariants
    this.identity.setStructure([
      'tool_approval_required',
      'context_budget_enforced',
      'variety_balance_maintained',
      'algedonic_channel_active',
      'session_continuity_preserved',
      'web_search_available',
      'save_learning_available',
    ])
  }

  /**
   * Create and evaluate a parameter modification proposal.
   *
   * BEHAVIORAL EFFECT: parameter changes are GATED. If the proposal
   * fails identity checks or is rejected, the change does not happen.
   *
   * @returns The proposal (Applied if accepted, Rejected/Failed otherwise)
   */
  proposeParameterChange(
    name: string,
    newValue: number,
    bounds: { min: number; max: number },
  ): InstanceType<typeof autopoiesis.Proposal> {
    const proposal = autopoiesis.Proposal.parameter(
      this.nodeId,
      name,
      newValue,
      bounds,
    )

    // Evaluate: auto-approve if within bounds, route to S5 otherwise
    const status = proposal.evaluate()

    // Emit domain event
    getEventBus().emit(events.DomainEvent.modificationProposed(
      this.nodeId,
      ModificationType.Parameter,
      `Change ${name} to ${newValue}`,
    ))

    if (status === autopoiesis.ProposalStatus.Approved) {
      // Check identity preservation before applying
      const currentStructure = [...this.identity.currentStructure]
      if (this.identity.preservesIdentity(currentStructure)) {
        proposal.apply()
        getEventBus().emit(events.DomainEvent.modificationDecided(
          this.nodeId,
          ModificationType.Parameter,
          true,
          `${name} = ${newValue} (within bounds, identity preserved)`,
        ))
      } else {
        proposal.fail('Would violate organizational identity')
        getEventBus().emit(events.DomainEvent.modificationDecided(
          this.nodeId,
          ModificationType.Parameter,
          false,
          'Identity violation',
        ))
      }
    } else if (status === autopoiesis.ProposalStatus.PendingS5) {
      // Out of bounds — auto-reject for now (S5 model would approve/reject)
      proposal.reject('Parameter out of bounds, S5 not available')
      getEventBus().emit(events.DomainEvent.modificationDecided(
        this.nodeId,
        ModificationType.Parameter,
        false,
        'Out of bounds',
      ))
    }

    this.proposalLog.push(proposal)
    return proposal
  }

  /**
   * Record an interaction for structural coupling tracking.
   *
   * @param userComplexity - how complex the user's message was (0-1)
   * @param systemComplexity - how complex the system's response was (0-1)
   */
  recordInteraction(userComplexity: number, systemComplexity: number): void {
    this.coupling.recordInteraction('user', 'system', userComplexity, systemComplexity)
  }

  /**
   * Get the coupling correlation between user and system.
   * High correlation = healthy co-drift.
   * Low/negative = system diverging from user needs.
   *
   * BEHAVIORAL EFFECT: dropping coupling triggers S4 advisor to reassess.
   */
  getCouplingScore(): number {
    return this.coupling.correlation('user', 'system') ?? 0
  }

  /**
   * Check organizational closure.
   * If not closed, some components depend on things the system can't produce.
   */
  checkClosure(): { closed: boolean; gaps: string[] } {
    return {
      closed: this.productionNetwork.isClosed(),
      gaps: this.productionNetwork.unproducedComponents(),
    }
  }

  /**
   * Get the identity score (0-1). 1.0 = all invariants preserved.
   */
  getIdentityScore(): number {
    return this.identity.identityScore
  }

  /**
   * Get proposal history for audit.
   */
  getProposalLog(): InstanceType<typeof autopoiesis.Proposal>[] {
    return this.proposalLog
  }
}
