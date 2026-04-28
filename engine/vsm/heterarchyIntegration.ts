/**
 * Heterarchy Integration — dynamic authority based on context.
 *
 * McCulloch's redundancy of potential command: the VSM system best
 * suited to the current context takes command. Authority shifts
 * dynamically based on situation.
 *
 * Behavioral effects:
 * - The commanding system's advisor gets priority
 * - Authority shifts: S3 in normal ops, S5 in crisis, S4 in exploration
 * - Missing redundancy emits alert (single point of failure)
 */

import { heterarchy } from '../cybernetics-core/src/index.js'

export type SystemContext = 'normal' | 'crisis' | 'exploration' | 'routine' | 'stuck'

export class HeterarchyIntegration {
  readonly registry: InstanceType<typeof heterarchy.CommandRegistry>
  readonly preferenceGraph: InstanceType<typeof heterarchy.HeterarchyGraph>

  constructor() {
    this.registry = new heterarchy.CommandRegistry()
    this.preferenceGraph = new heterarchy.HeterarchyGraph()

    // Register authority scores per context
    // Normal operation: S3 commands resource allocation
    this.registry.register('S1', 'normal', 0.3)
    this.registry.register('S2', 'normal', 0.4)
    this.registry.register('S3', 'normal', 0.9)
    this.registry.register('S4', 'normal', 0.5)
    this.registry.register('S5', 'normal', 0.3)

    // Crisis (algedonic critical): S5 takes command
    this.registry.register('S1', 'crisis', 0.1)
    this.registry.register('S2', 'crisis', 0.3)
    this.registry.register('S3', 'crisis', 0.5)
    this.registry.register('S4', 'crisis', 0.4)
    this.registry.register('S5', 'crisis', 1.0)

    // Exploration (new task type): S4 leads
    this.registry.register('S1', 'exploration', 0.2)
    this.registry.register('S2', 'exploration', 0.3)
    this.registry.register('S3', 'exploration', 0.4)
    this.registry.register('S4', 'exploration', 0.9)
    this.registry.register('S5', 'exploration', 0.5)

    // Routine execution: S1 has autonomy
    this.registry.register('S1', 'routine', 0.9)
    this.registry.register('S2', 'routine', 0.5)
    this.registry.register('S3', 'routine', 0.3)
    this.registry.register('S4', 'routine', 0.2)
    this.registry.register('S5', 'routine', 0.1)

    // Stuck: S2 coordination + S4 intelligence
    this.registry.register('S1', 'stuck', 0.1)
    this.registry.register('S2', 'stuck', 0.7)
    this.registry.register('S3', 'stuck', 0.5)
    this.registry.register('S4', 'stuck', 0.8)
    this.registry.register('S5', 'stuck', 0.6)

    // Set up heterarchical preferences (non-transitive)
    // Normal: S3 > S4 > S2 > S3 (cycle! healthy heterarchy)
    this.preferenceGraph.addPreference('S3', 'S4')
    this.preferenceGraph.addPreference('S4', 'S2')
    this.preferenceGraph.addPreference('S2', 'S3')
  }

  /**
   * Determine who commands in the current context.
   *
   * BEHAVIORAL EFFECT: the commanding system's advisor gets priority.
   */
  whoCommands(context: SystemContext): string {
    const result = this.registry.whoCommands(context)
    return result?.component ?? 'S3'
  }

  /**
   * Check redundancy for a context.
   *
   * BEHAVIORAL EFFECT: missing redundancy = single point of failure alert.
   */
  hasRedundancy(context: SystemContext): boolean {
    return this.registry.hasRedundancy(context)
  }

  /**
   * Classify the current system state into a context.
   */
  classifyContext(
    stuckTurns: number,
    algedonicCritical: boolean,
    isNewTaskType: boolean,
    toolsUsedRecently: number,
  ): SystemContext {
    if (algedonicCritical) return 'crisis'
    if (stuckTurns >= 3) return 'stuck'
    if (isNewTaskType) return 'exploration'
    if (toolsUsedRecently > 3) return 'routine'
    return 'normal'
  }

  /**
   * Does the preference graph have healthy cycles (heterarchy, not hierarchy)?
   */
  isHealthyHeterarchy(): boolean {
    return this.preferenceGraph.hasCycle()
  }
}
