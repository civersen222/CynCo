/**
 * Conformance tests for metrics module.
 * Each test mirrors the Rust test suite in cybernetics/src/metrics/
 */
import { describe, it, expect } from 'vitest';
import {
  Achievement,
  performanceIndicesFromAchievement,
  performanceHealth,
  CusumDetector,
} from '../../src/metrics';

// ============================================================================
// Achievement tests (mirrors achievement.rs)
// ============================================================================

describe('achievement', () => {
  it('valid_achievement', () => {
    const a = new Achievement(70.0, 90.0, 100.0);
    expect(Math.abs(a.actuality - 70.0)).toBeLessThan(Number.EPSILON);
  });

  it('actuality_cannot_exceed_capability', () => {
    expect(() => new Achievement(100.0, 90.0, 100.0)).toThrow();
  });

  it('capability_cannot_exceed_potentiality', () => {
    expect(() => new Achievement(50.0, 110.0, 100.0)).toThrow();
  });

  it('negative_values_rejected', () => {
    expect(() => new Achievement(-1.0, 90.0, 100.0)).toThrow();
  });

  it('productivity_ratio', () => {
    const a = new Achievement(70.0, 100.0, 100.0);
    expect(Math.abs(a.productivity() - 0.7)).toBeLessThan(Number.EPSILON);
  });

  it('latency_ratio', () => {
    const a = new Achievement(50.0, 80.0, 100.0);
    expect(Math.abs(a.latency() - 0.8)).toBeLessThan(Number.EPSILON);
  });

  it('performance_ratio', () => {
    const a = new Achievement(60.0, 80.0, 100.0);
    expect(Math.abs(a.performance() - 0.6)).toBeLessThan(Number.EPSILON);
  });

  it('zero_capability_handled', () => {
    const a = new Achievement(0.0, 0.0, 0.0);
    expect(a.productivity()).toBe(0.0);
    expect(a.latency()).toBe(0.0);
    expect(a.performance()).toBe(0.0);
  });

  it('performance_equals_productivity_times_latency', () => {
    const a = new Achievement(60.0, 80.0, 100.0);
    const product = a.productivity() * a.latency();
    expect(Math.abs(a.performance() - product)).toBeLessThan(1e-10);
  });

  it('boundary_equal_values', () => {
    const a = new Achievement(50.0, 50.0, 50.0);
    expect(Math.abs(a.productivity() - 1.0)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(a.latency() - 1.0)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(a.performance() - 1.0)).toBeLessThan(Number.EPSILON);
  });

  it('zero_actuality', () => {
    const a = new Achievement(0.0, 80.0, 100.0);
    expect(a.productivity()).toBe(0.0);
    expect(a.performance()).toBe(0.0);
    expect(Math.abs(a.latency() - 0.8)).toBeLessThan(Number.EPSILON);
  });
});

// ============================================================================
// Performance Indices tests (mirrors indices.rs)
// ============================================================================

describe('performance indices', () => {
  it('from_achievement', () => {
    const a = new Achievement(60.0, 80.0, 100.0);
    const idx = performanceIndicesFromAchievement(a);
    expect(Math.abs(idx.productivity - 0.75)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(idx.latency - 0.8)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(idx.performance - 0.6)).toBeLessThan(Number.EPSILON);
  });

  it('health_average', () => {
    const a = new Achievement(60.0, 80.0, 100.0);
    const idx = performanceIndicesFromAchievement(a);
    const expected = (0.75 + 0.8 + 0.6) / 3.0;
    expect(Math.abs(performanceHealth(idx) - expected)).toBeLessThan(1e-10);
  });

  it('perfect_health', () => {
    const a = new Achievement(100.0, 100.0, 100.0);
    const idx = performanceIndicesFromAchievement(a);
    expect(Math.abs(performanceHealth(idx) - 1.0)).toBeLessThan(Number.EPSILON);
  });

  it('zero_health', () => {
    const a = new Achievement(0.0, 0.0, 0.0);
    const idx = performanceIndicesFromAchievement(a);
    expect(Math.abs(performanceHealth(idx) - 0.0)).toBeLessThan(Number.EPSILON);
  });

  it('performance_is_product_of_productivity_and_latency', () => {
    const a = new Achievement(42.0, 70.0, 100.0);
    const idx = performanceIndicesFromAchievement(a);
    const product = idx.productivity * idx.latency;
    expect(Math.abs(idx.performance - product)).toBeLessThan(1e-10);
  });
});

// ============================================================================
// CUSUM Drift tests (mirrors drift.rs)
// ============================================================================

describe('cusum drift', () => {
  it('no_drift_stable_signal', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    for (let i = 0; i < 20; i++) {
      expect(cusum.update(0.0)).toBe(false);
    }
  });

  it('detects_positive_drift', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    let detected = false;
    for (let i = 0; i < 20; i++) {
      if (cusum.update(1.0)) {
        detected = true;
        break;
      }
    }
    expect(detected).toBe(true);
  });

  it('detects_negative_drift', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    let detected = false;
    for (let i = 0; i < 20; i++) {
      if (cusum.update(-1.0)) {
        detected = true;
        break;
      }
    }
    expect(detected).toBe(true);
  });

  it('reset_clears_state', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    for (let i = 0; i < 10; i++) {
      cusum.update(1.0);
    }
    cusum.reset();
    expect(Math.abs(cusum.upper() - 0.0)).toBeLessThan(Number.EPSILON);
    expect(Math.abs(cusum.lower() - 0.0)).toBeLessThan(Number.EPSILON);
  });

  it('upper_accumulates_positive_deviation', () => {
    const cusum = new CusumDetector(10.0, 0.5);
    cusum.update(2.0); // upper = max(0 + 2.0 - 0.5, 0) = 1.5
    expect(Math.abs(cusum.upper() - 1.5)).toBeLessThan(Number.EPSILON);
    cusum.update(2.0); // upper = max(1.5 + 2.0 - 0.5, 0) = 3.0
    expect(Math.abs(cusum.upper() - 3.0)).toBeLessThan(Number.EPSILON);
  });

  it('lower_accumulates_negative_deviation', () => {
    const cusum = new CusumDetector(10.0, 0.5);
    cusum.update(-2.0); // lower = max(0 - (-2.0) - 0.5, 0) = 1.5
    expect(Math.abs(cusum.lower() - 1.5)).toBeLessThan(Number.EPSILON);
    cusum.update(-2.0); // lower = max(1.5 + 2.0 - 0.5, 0) = 3.0
    expect(Math.abs(cusum.lower() - 3.0)).toBeLessThan(Number.EPSILON);
  });

  it('small_deviations_absorbed_by_slack', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    // deviation of 0.3, slack of 0.5: 0.3 - 0.5 = -0.2, clamped to 0
    for (let i = 0; i < 100; i++) {
      expect(cusum.update(0.3)).toBe(false);
    }
    expect(Math.abs(cusum.upper() - 0.0)).toBeLessThan(Number.EPSILON);
  });

  it('reset_after_detection_allows_reuse', () => {
    const cusum = new CusumDetector(1.0, 0.5);
    // Drive to detection
    while (!cusum.update(1.0)) { /* keep going */ }
    cusum.reset();
    // Should not immediately detect
    expect(cusum.update(0.0)).toBe(false);
  });
});
