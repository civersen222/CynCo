/**
 * Conformance tests for homeostat module.
 * Each test mirrors the Rust test suite in cybernetics/src/homeostat/
 */
import { describe, it, expect } from 'vitest';
import {
  calculateBalance,
  calculateBalanceFromInputs,
  calculateMetasystem,
  TrendTracker,
  AshbyHomeostat,
  measureRelaxation,
  timeConstantForLevel,
  SYSTEM_TIME_CONSTANTS,
  S5Favor,
} from '../../src/homeostat';
import { HomeostatBalance, TrendDirection } from '../../src/types';

// ============================================================================
// Balance tests (mirrors balance.rs)
// ============================================================================

describe('balance', () => {
  it('equal_pressures_balanced', () => {
    const result = calculateBalance(0.5, 0.5);
    expect(result.balance).toBe(HomeostatBalance.Balanced);
    expect(Math.abs(result.ratio - 1.0)).toBeLessThan(0.1);
  });

  it('high_s3_low_s4_s3_dominant', () => {
    const result = calculateBalance(0.8, 0.2);
    expect(result.balance).toBe(HomeostatBalance.S3Dominant);
  });

  it('low_s3_high_s4_s4_dominant', () => {
    const result = calculateBalance(0.2, 0.6);
    expect(result.balance).toBe(HomeostatBalance.S4Dominant);
  });

  it('extreme_imbalance_critical', () => {
    const result = calculateBalance(0.9, 0.05);
    expect(result.balance).toBe(HomeostatBalance.Critical);
  });

  it('zero_pressures_balanced', () => {
    const result = calculateBalance(0.0, 0.0);
    expect(result.balance).toBe(HomeostatBalance.Balanced);
  });

  it('conflict_detected', () => {
    const result = calculateBalance(0.7, 0.7);
    expect(result.conflict).toBe(true);
  });

  it('no_conflict_when_one_low', () => {
    const result = calculateBalance(0.8, 0.3);
    expect(result.conflict).toBe(false);
  });

  it('pressure_from_inputs', () => {
    const s3 = [{ urgency: 0.8 }, { urgency: 0.4 }];
    const s4 = [{ confidence: 0.6 }];
    const result = calculateBalanceFromInputs(s3, s4);
    expect(result.balance).toBe(HomeostatBalance.Balanced);
  });
});

// ============================================================================
// Trend tests (mirrors trend.rs)
// ============================================================================

describe('trend', () => {
  it('empty_trend_is_stable', () => {
    const t = new TrendTracker(20);
    expect(t.direction()).toBe(TrendDirection.Stable);
    expect(t.isEmpty()).toBe(true);
  });

  it('rising_trend_detected', () => {
    const t = new TrendTracker(10);
    for (let i = 0; i < 10; i++) {
      t.push(i * 0.2);
    }
    expect(t.direction()).toBe(TrendDirection.Rising);
  });

  it('falling_trend_detected', () => {
    const t = new TrendTracker(10);
    for (let i = 9; i >= 0; i--) {
      t.push(i * 0.2);
    }
    expect(t.direction()).toBe(TrendDirection.Falling);
  });

  it('stable_trend', () => {
    const t = new TrendTracker(10);
    for (let i = 0; i < 10; i++) {
      t.push(1.0);
    }
    expect(t.direction()).toBe(TrendDirection.Stable);
  });

  it('window_size_respected', () => {
    const t = new TrendTracker(5);
    for (let i = 0; i < 10; i++) {
      t.push(i);
    }
    expect(t.len()).toBe(5);
  });

  it('default_window_20', () => {
    const t = new TrendTracker();
    expect(t.len()).toBe(0);
  });

  it('latest_returns_last', () => {
    const t = new TrendTracker(5);
    t.push(1.0);
    t.push(2.0);
    expect(t.latest()).toBe(2.0);
  });
});

// ============================================================================
// Metasystem tests (mirrors metasystem.rs)
// ============================================================================

describe('metasystem', () => {
  it('balanced_with_s5_neutral', () => {
    const state = calculateMetasystem(0.5, 0.5, 0.5, S5Favor.Neither);
    expect(state.balance).toBe(HomeostatBalance.Balanced);
    expect(state.coherence).toBeGreaterThan(0.5);
  });

  it('s5_shifts_toward_s3', () => {
    const neutral = calculateMetasystem(0.4, 0.6, 0.8, S5Favor.Neither);
    const s3Favor = calculateMetasystem(0.4, 0.6, 0.8, S5Favor.S3Operations);
    // S5 favoring S3 should increase effective s3 pressure
    expect(s3Favor.s3Pressure).toBeGreaterThan(neutral.s3Pressure);
  });

  it('s5_shifts_toward_s4', () => {
    const neutral = calculateMetasystem(0.6, 0.4, 0.8, S5Favor.Neither);
    const s4Favor = calculateMetasystem(0.6, 0.4, 0.8, S5Favor.S4Intelligence);
    expect(s4Favor.s4Pressure).toBeGreaterThan(neutral.s4Pressure);
  });

  it('high_coherence_when_balanced_and_engaged', () => {
    const state = calculateMetasystem(0.5, 0.5, 1.0, S5Favor.Neither);
    expect(state.coherence).toBeGreaterThan(0.8);
  });

  it('low_coherence_when_imbalanced_and_disengaged', () => {
    const state = calculateMetasystem(0.9, 0.1, 0.0, S5Favor.Neither);
    expect(state.coherence).toBeLessThan(0.5);
  });

  it('pressures_clamped_to_unit_range', () => {
    const state = calculateMetasystem(0.95, 0.05, 1.0, S5Favor.S3Operations);
    expect(state.s3Pressure).toBeLessThanOrEqual(1.0);
    expect(state.s4Pressure).toBeGreaterThanOrEqual(0.0);
  });
});

// ============================================================================
// Ashby Homeostat tests (mirrors ashby_homeostat.rs)
// ============================================================================

describe('ashby homeostat', () => {
  it('new_homeostat_zeroed', () => {
    const h = new AshbyHomeostat(4, 1.0, 1.0);
    expect(h.states).toEqual([0.0, 0.0, 0.0, 0.0]);
    expect(h.isStable(0.001)).toBe(true);
  });

  it('perturbation_decays_with_damping', () => {
    const h = new AshbyHomeostat(2, 2.0, 1.0);
    h.setState(0, 1.0);
    h.run(100, 0.1);
    // With damping > coupling, state should decay toward 0
    expect(Math.abs(h.states[0])).toBeLessThan(0.1);
  });

  it('coupled_units_influence_each_other', () => {
    const h = new AshbyHomeostat(2, 1.0, 1.0);
    h.setWeight(0, 1, 0.5); // unit 1 influences unit 0
    h.setWeight(1, 0, 0.5); // unit 0 influences unit 1
    h.setState(0, 1.0);
    h.step(0.1);
    // Unit 1 should have moved from 0 due to coupling
    expect(h.states[1]).not.toBe(0.0);
  });

  it('stability_detection', () => {
    const h = new AshbyHomeostat(2, 2.0, 1.0);
    h.setState(0, 1.0);
    expect(h.isStable(0.001)).toBe(false);
    h.run(200, 0.1);
    expect(h.isStable(0.01)).toBe(true);
  });

  it('randomize_weights_changes_state', () => {
    const h = new AshbyHomeostat(3, 1.0, 1.0);
    h.setState(0, 0.5);
    h.randomizeWeights(1.0);
    // At least some off-diagonal weights should be non-zero
    const hasNonzero = h.weights.some(row => row.some(w => w !== 0.0));
    expect(hasNonzero).toBe(true);
  });
});

// ============================================================================
// Time tests (mirrors time.rs)
// ============================================================================

describe('time', () => {
  it('time_constants_increase_with_level', () => {
    for (let i = 0; i < 4; i++) {
      expect(SYSTEM_TIME_CONSTANTS[i].tau).toBeLessThan(SYSTEM_TIME_CONSTANTS[i + 1].tau);
    }
  });

  it('s1_fastest', () => {
    expect(timeConstantForLevel(1)).toBe(1.0);
  });

  it('s5_slowest', () => {
    expect(timeConstantForLevel(5)).toBe(3600.0);
  });

  it('healthy_relaxation', () => {
    const m = measureRelaxation(3, 0.5, 90.0); // 3 * 30 = 90, exactly expected
    expect(m.healthy).toBe(true);
  });

  it('too_slow_relaxation', () => {
    const m = measureRelaxation(1, 0.5, 100.0); // 3 * 1 = 3, way too slow
    expect(m.healthy).toBe(false);
  });

  it('too_fast_relaxation', () => {
    const m = measureRelaxation(5, 0.5, 1.0); // 3 * 3600 = 10800, way too fast
    expect(m.healthy).toBe(false);
  });
});
