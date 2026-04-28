/**
 * S2 Coordination: Steering queue for conversation loop interrupts.
 * Replaces inline nudge counter, summary injection, and read loop detection.
 */

export type SteeringMessage = {
  type: 'steer' | 'followUp'
  text: string
  source: string  // 'nudge' | 'summary' | 'readLoop' | 'governance' | etc.
}

export class SteeringQueue {
  private steers: SteeringMessage[] = []
  private followUps: SteeringMessage[] = []

  /** Priority interrupt -- injected at next safe point in the model loop. */
  steer(text: string, source: string): void {
    this.steers.push({ type: 'steer', text, source })
  }

  /** Queued for after model finishes current turn. */
  followUp(text: string, source: string): void {
    this.followUps.push({ type: 'followUp', text, source })
  }

  hasSteer(): boolean { return this.steers.length > 0 }
  hasFollowUp(): boolean { return this.followUps.length > 0 }

  nextSteer(): SteeringMessage | undefined { return this.steers.shift() }
  nextFollowUp(): SteeringMessage | undefined { return this.followUps.shift() }

  clear(): void { this.steers = []; this.followUps = [] }
}
