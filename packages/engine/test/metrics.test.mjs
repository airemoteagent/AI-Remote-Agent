import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let computeRunMetrics, evaluateAlerts;

before(async () => ({ computeRunMetrics, evaluateAlerts } = await import('../src/index.mjs')));

const run = (over = {}) => ({ status: 'succeeded', attempts: [], approvals: [], ...over });

describe('computeRunMetrics', () => {
  it('aggregates success, failure, and rollback rates', () => {
    const metrics = computeRunMetrics([
      run({ status: 'succeeded' }),
      run({ status: 'succeeded' }),
      run({ status: 'failed' }),
      run({ status: 'rolled_back' }),
      run({ status: 'running' }),
    ]);
    assert.equal(metrics.total, 5);
    assert.equal(metrics.succeeded, 2);
    assert.equal(metrics.failed, 1);
    assert.equal(metrics.rolledBack, 1);
    assert.equal(metrics.active, 1);
    assert.equal(metrics.successRate, 0.4);
    assert.equal(metrics.failureRate, 0.2);
    assert.equal(metrics.rollbackRate, 0.2);
  });

  it('flags unsafe interrupted side effects as manual review (not idempotent ones)', () => {
    const metrics = computeRunMetrics([
      run({
        status: 'running',
        attempts: [
          { status: 'unknown', sideEffects: true, idempotent: false, idempotencyKey: 'k' },
          { status: 'unknown', sideEffects: true, idempotent: true, idempotencyKey: 'k2' },
        ],
      }),
    ]);
    assert.equal(metrics.manualReview, 1);
  });

  it('handles empty input without division errors', () => {
    const metrics = computeRunMetrics([]);
    assert.equal(metrics.total, 0);
    assert.equal(metrics.successRate, 0);
    assert.equal(metrics.failureRate, 0);
  });
});

describe('evaluateAlerts', () => {
  it('raises critical audit-chain alert and manual-review alert', () => {
    const alerts = evaluateAlerts({ manualReview: 1, rollbackRate: 0, failureRate: 0 }, { auditOk: false });
    assert.ok(alerts.some((a) => a.code === 'audit_chain_broken' && a.severity === 'critical'));
    assert.ok(alerts.some((a) => a.code === 'manual_review_required' && a.severity === 'high'));
  });

  it('raises rollback and failure alerts only above their thresholds', () => {
    const hot = evaluateAlerts({ manualReview: 0, rollbackRate: 0.3, failureRate: 0.5 }, { auditOk: true });
    assert.ok(hot.some((a) => a.code === 'elevated_rollback_rate'));
    assert.ok(hot.some((a) => a.code === 'elevated_failure_rate'));

    const cold = evaluateAlerts({ manualReview: 0, rollbackRate: 0, failureRate: 0 }, { auditOk: true });
    assert.deepEqual(cold, []);
  });
});
