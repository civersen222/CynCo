/**
 * Conformance tests for autopoiesis module.
 * Each test mirrors the Rust test suite in cybernetics/src/autopoiesis/
 */
import { describe, it, expect } from 'vitest';
import {
  isAutopoietic,
  missingCriteria,
  ProductionNetwork,
  Proposal,
  ProposalStatus,
  StructuralCoupling,
  OrganizationalIdentity,
  type AutopoiesisAssessment,
} from '../../src/autopoiesis';
import { NodeId } from '../../src/types';

// ============================================================================
// Criteria tests (mirrors criteria.rs)
// ============================================================================

function fullAutopoietic(): AutopoiesisAssessment {
  return {
    hasBoundary: true,
    boundarySelfProduced: true,
    internalProduction: true,
    circularProduction: true,
    organizationallyClosed: true,
    organizationMaintained: true,
  };
}

describe('criteria', () => {
  it('all_criteria_met_is_autopoietic', () => {
    const a = fullAutopoietic();
    expect(isAutopoietic(a)).toBe(true);
    expect(missingCriteria(a)).toEqual([]);
  });

  it('missing_boundary_not_autopoietic', () => {
    const a = fullAutopoietic();
    a.hasBoundary = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['distinguishable boundary']);
  });

  it('missing_self_produced_boundary', () => {
    const a = fullAutopoietic();
    a.boundarySelfProduced = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['self-produced boundary']);
  });

  it('missing_internal_production', () => {
    const a = fullAutopoietic();
    a.internalProduction = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['internal component production']);
  });

  it('missing_circular_production', () => {
    const a = fullAutopoietic();
    a.circularProduction = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['circular production']);
  });

  it('missing_organizational_closure', () => {
    const a = fullAutopoietic();
    a.organizationallyClosed = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['organizational closure']);
  });

  it('missing_organization_maintenance', () => {
    const a = fullAutopoietic();
    a.organizationMaintained = false;
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a)).toEqual(['organization maintenance']);
  });

  it('all_criteria_missing', () => {
    const a: AutopoiesisAssessment = {
      hasBoundary: false,
      boundarySelfProduced: false,
      internalProduction: false,
      circularProduction: false,
      organizationallyClosed: false,
      organizationMaintained: false,
    };
    expect(isAutopoietic(a)).toBe(false);
    expect(missingCriteria(a).length).toBe(6);
  });

  it('multiple_missing_criteria', () => {
    const a = fullAutopoietic();
    a.hasBoundary = false;
    a.circularProduction = false;
    expect(isAutopoietic(a)).toBe(false);
    const missing = missingCriteria(a);
    expect(missing.length).toBe(2);
    expect(missing).toContain('distinguishable boundary');
    expect(missing).toContain('circular production');
  });
});

// ============================================================================
// Closure tests (mirrors closure.rs)
// ============================================================================

describe('closure', () => {
  it('empty_network_is_closed', () => {
    const net = new ProductionNetwork();
    expect(net.isClosed()).toBe(true); // vacuously true
  });

  it('single_self_producing_component_is_closed', () => {
    const net = new ProductionNetwork();
    const a = net.addComponent('A');
    net.addProduction(a, a); // A produces itself
    expect(net.isClosed()).toBe(true);
  });

  it('single_unproduced_component_not_closed', () => {
    const net = new ProductionNetwork();
    net.addComponent('A');
    expect(net.isClosed()).toBe(false);
    expect(net.unproducedComponents()).toEqual(['A']);
  });

  it('circular_production_is_closed', () => {
    const net = new ProductionNetwork();
    const a = net.addComponent('A');
    const b = net.addComponent('B');
    const c = net.addComponent('C');
    net.addProduction(a, b); // A produces B
    net.addProduction(b, c); // B produces C
    net.addProduction(c, a); // C produces A
    expect(net.isClosed()).toBe(true);
    expect(net.unproducedComponents()).toEqual([]);
  });

  it('partial_closure_detected', () => {
    const net = new ProductionNetwork();
    const a = net.addComponent('A');
    const b = net.addComponent('B');
    net.addComponent('C'); // C is not produced by anyone
    net.addProduction(a, b); // A produces B
    net.addProduction(b, a); // B produces A
    expect(net.isClosed()).toBe(false);
    expect(net.unproducedComponents()).toEqual(['C']);
  });

  it('multiple_producers_for_same_product', () => {
    const net = new ProductionNetwork();
    const a = net.addComponent('A');
    const b = net.addComponent('B');
    net.addProduction(a, b);
    net.addProduction(b, a);
    net.addProduction(a, a); // redundant but valid
    expect(net.isClosed()).toBe(true);
  });

  it('component_count', () => {
    const net = new ProductionNetwork();
    expect(net.componentCount()).toBe(0);
    net.addComponent('X');
    net.addComponent('Y');
    expect(net.componentCount()).toBe(2);
  });

  it('production_count', () => {
    const net = new ProductionNetwork();
    const a = net.addComponent('A');
    const b = net.addComponent('B');
    expect(net.productionCount()).toBe(0);
    net.addProduction(a, b);
    expect(net.productionCount()).toBe(1);
  });
});

// ============================================================================
// Proposal tests (mirrors proposal.rs)
// ============================================================================

describe('proposal', () => {
  it('parameter_proposal_auto_approves_in_bounds', () => {
    const p = Proposal.parameter(
      NodeId.new(),
      'threshold',
      0.7,
      { min: 0.5, max: 0.95 },
    );
    expect(p.status).toBe(ProposalStatus.Proposed);
    const decided = p.evaluate();
    expect(decided).toBe(ProposalStatus.Approved);
  });

  it('parameter_proposal_out_of_bounds_routes_s5', () => {
    const p = Proposal.parameter(
      NodeId.new(),
      'threshold',
      0.3,
      { min: 0.5, max: 0.95 },
    );
    const decided = p.evaluate();
    expect(decided).toBe(ProposalStatus.PendingS5);
  });

  it('workflow_proposal_routes_s5', () => {
    const p = Proposal.workflow(
      NodeId.new(),
      'change approval chain',
    );
    const decided = p.evaluate();
    expect(decided).toBe(ProposalStatus.PendingS5);
  });

  it('code_proposal_routes_human', () => {
    const p = Proposal.code(
      NodeId.new(),
      'add new validation rule',
    );
    const decided = p.evaluate();
    expect(decided).toBe(ProposalStatus.PendingHuman);
  });

  it('approve_pending_s5', () => {
    const p = Proposal.workflow(NodeId.new(), 'test');
    p.evaluate();
    expect(p.status).toBe(ProposalStatus.PendingS5);
    p.approve('s5 approved');
    expect(p.status).toBe(ProposalStatus.Approved);
  });

  it('reject_pending', () => {
    const p = Proposal.workflow(NodeId.new(), 'test');
    p.evaluate();
    p.reject('not aligned with policy');
    expect(p.status).toBe(ProposalStatus.Rejected);
  });

  it('apply_approved', () => {
    const p = Proposal.parameter(
      NodeId.new(), 'x', 0.7,
      { min: 0.5, max: 0.95 },
    );
    p.evaluate();
    expect(p.status).toBe(ProposalStatus.Approved);
    p.apply();
    expect(p.status).toBe(ProposalStatus.Applied);
  });

  it('cannot_apply_unapproved', () => {
    const p = Proposal.workflow(NodeId.new(), 'test');
    p.evaluate(); // PendingS5
    expect(() => p.apply()).toThrow();
  });

  it('revert_applied', () => {
    const p = Proposal.parameter(
      NodeId.new(), 'x', 0.7,
      { min: 0.5, max: 0.95 },
    );
    p.evaluate();
    p.apply();
    expect(p.status).toBe(ProposalStatus.Applied);
    p.revert();
    expect(p.status).toBe(ProposalStatus.Reverted);
  });

  it('cannot_revert_unapplied', () => {
    const p = Proposal.parameter(
      NodeId.new(), 'x', 0.7,
      { min: 0.5, max: 0.95 },
    );
    p.evaluate();
    expect(() => p.revert()).toThrow();
  });

  it('fail_sets_reason', () => {
    const p = Proposal.workflow(NodeId.new(), 'test');
    p.fail('runtime error');
    expect(p.status).toBe(ProposalStatus.Failed);
    expect(p.decisionReason).toBe('runtime error');
  });

  it('parameter_at_boundary_approved', () => {
    // Exact min
    const p1 = Proposal.parameter(
      NodeId.new(), 'x', 0.5,
      { min: 0.5, max: 0.95 },
    );
    expect(p1.evaluate()).toBe(ProposalStatus.Approved);

    // Exact max
    const p2 = Proposal.parameter(
      NodeId.new(), 'x', 0.95,
      { min: 0.5, max: 0.95 },
    );
    expect(p2.evaluate()).toBe(ProposalStatus.Approved);
  });
});

// ============================================================================
// Coupling tests (mirrors coupling.rs)
// ============================================================================

describe('coupling', () => {
  it('no_interactions_returns_undefined', () => {
    const sc = new StructuralCoupling();
    expect(sc.correlation('a', 'b')).toBeUndefined();
  });

  it('single_interaction_returns_zero_correlation', () => {
    const sc = new StructuralCoupling();
    sc.recordInteraction('a', 'b', 1.0, 2.0);
    // With only one data point, correlation is 0.0
    expect(sc.correlation('a', 'b')).toBe(0.0);
  });

  it('perfect_positive_correlation', () => {
    const sc = new StructuralCoupling();
    // a_state and b_state move in lockstep
    sc.recordInteraction('a', 'b', 1.0, 10.0);
    sc.recordInteraction('a', 'b', 2.0, 20.0);
    sc.recordInteraction('a', 'b', 3.0, 30.0);
    const r = sc.correlation('a', 'b')!;
    expect(Math.abs(r - 1.0)).toBeLessThan(1e-10);
  });

  it('perfect_negative_correlation', () => {
    const sc = new StructuralCoupling();
    sc.recordInteraction('a', 'b', 1.0, 30.0);
    sc.recordInteraction('a', 'b', 2.0, 20.0);
    sc.recordInteraction('a', 'b', 3.0, 10.0);
    const r = sc.correlation('a', 'b')!;
    expect(Math.abs(r - (-1.0))).toBeLessThan(1e-10);
  });

  it('order_independent', () => {
    const sc = new StructuralCoupling();
    sc.recordInteraction('b', 'a', 1.0, 10.0);
    sc.recordInteraction('a', 'b', 2.0, 20.0);
    // Should merge into the same record regardless of order
    const r = sc.correlation('a', 'b');
    const r2 = sc.correlation('b', 'a');
    expect(r).toEqual(r2);
    expect(r).toBeDefined();
  });

  it('strongly_coupled_filters', () => {
    const sc = new StructuralCoupling();
    // Strong positive correlation between a-b
    sc.recordInteraction('a', 'b', 1.0, 10.0);
    sc.recordInteraction('a', 'b', 2.0, 20.0);
    sc.recordInteraction('a', 'b', 3.0, 30.0);

    // Weak/no correlation between c-d (constant values)
    sc.recordInteraction('c', 'd', 5.0, 5.0);
    sc.recordInteraction('c', 'd', 5.0, 5.0);
    sc.recordInteraction('c', 'd', 5.0, 5.0);

    const strong = sc.stronglyCoupled(0.9);
    expect(strong.length).toBe(1);
    expect(strong[0].systemA).toBe('a');
    expect(strong[0].systemB).toBe('b');
  });

  it('all_records', () => {
    const sc = new StructuralCoupling();
    sc.recordInteraction('a', 'b', 1.0, 2.0);
    sc.recordInteraction('c', 'd', 3.0, 4.0);
    expect(sc.allRecords().length).toBe(2);
  });
});

// ============================================================================
// Identity tests (mirrors identity.rs)
// ============================================================================

describe('identity', () => {
  it('new_identity_has_full_score', () => {
    const id = new OrganizationalIdentity(
      'test-system',
      ['feedback-loop', 'boundary'],
    );
    expect(Math.abs(id.identityScore - 1.0)).toBeLessThan(Number.EPSILON);
    expect(id.name).toBe('test-system');
    expect(id.currentStructure).toEqual([]);
  });

  it('preserves_identity_with_all_invariants', () => {
    const id = new OrganizationalIdentity(
      'sys',
      ['feedback-loop', 'boundary'],
    );
    const proposed = ['feedback-loop', 'boundary', 'new-component'];
    expect(id.preservesIdentity(proposed)).toBe(true);
  });

  it('does_not_preserve_identity_with_missing_invariant', () => {
    const id = new OrganizationalIdentity(
      'sys',
      ['feedback-loop', 'boundary'],
    );
    const proposed = ['feedback-loop', 'new-component'];
    expect(id.preservesIdentity(proposed)).toBe(false);
  });

  it('empty_invariants_always_preserved', () => {
    const id = new OrganizationalIdentity('sys', []);
    expect(id.preservesIdentity(['anything'])).toBe(true);
    expect(id.preservesIdentity([])).toBe(true);
  });

  it('set_structure_updates_score', () => {
    const id = new OrganizationalIdentity(
      'sys',
      ['feedback-loop', 'boundary'],
    );
    id.setStructure(['feedback-loop', 'boundary']);
    expect(Math.abs(id.identityScore - 1.0)).toBeLessThan(Number.EPSILON);

    id.setStructure(['feedback-loop']); // missing boundary
    expect(Math.abs(id.identityScore - 0.5)).toBeLessThan(Number.EPSILON);

    id.setStructure(['unrelated']); // missing both
    expect(Math.abs(id.identityScore - 0.0)).toBeLessThan(Number.EPSILON);
  });

  it('score_with_no_invariants', () => {
    const id = new OrganizationalIdentity('sys', []);
    id.setStructure(['anything']);
    expect(Math.abs(id.identityScore - 1.0)).toBeLessThan(Number.EPSILON);
  });

  it('preserves_identity_empty_proposal', () => {
    const id = new OrganizationalIdentity(
      'sys',
      ['feedback-loop'],
    );
    expect(id.preservesIdentity([])).toBe(false);
  });
});
