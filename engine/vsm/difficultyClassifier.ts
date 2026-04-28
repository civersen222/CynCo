export type DifficultyLevel = 'unknown' | 'easy' | 'medium' | 'hard' | 'expert'
export type GovernanceIntensity = 0 | 1 | 2 | 3

type TurnData = { toolCalls: number; errors: number; tokens: number }

export class DifficultyClassifier {
  private turns: TurnData[] = []
  private _level: DifficultyLevel = 'unknown'

  recordTurn(data: TurnData): void {
    this.turns.push(data)
    this._classify()
  }

  private _classify(): void {
    const totalTools = this.turns.reduce((s, t) => s + t.toolCalls, 0)
    const totalErrors = this.turns.reduce((s, t) => s + t.errors, 0)
    const turnCount = this.turns.length

    if (turnCount >= 2 && totalTools < 4 && totalErrors === 0) {
      this._level = 'easy'
    } else if (turnCount >= 3 && totalErrors >= 3 && totalTools > 20) {
      this._level = 'expert'
    } else if (totalErrors > 0 || totalTools > 10) {
      this._level = 'hard'
    } else if (turnCount >= 3) {
      this._level = 'medium'
    }
  }

  getLevel(): DifficultyLevel { return this._level }

  getGovernanceIntensity(level?: DifficultyLevel): GovernanceIntensity {
    const l = level ?? this._level
    switch (l) {
      case 'easy': return 0
      case 'unknown': case 'medium': return 1
      case 'hard': return 2
      case 'expert': return 3
    }
  }

  shouldInjectSignals(): boolean { return this.getGovernanceIntensity() >= 2 }
  shouldForceTests(): boolean { return this.getGovernanceIntensity() >= 1 }
}
