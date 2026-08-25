// Value metrics and operational alerting over the durable run ledger.
//
// computeRunMetrics aggregates a set of normalised runs (as returned by
// RunStore.list()) into operator/executive-facing metrics. evaluateAlerts turns
// those metrics — plus the audit-chain integrity result — into actionable
// alerts. Both are pure functions, so they are trivially unit-testable offline
// and reusable by a dashboard or SIEM exporter.

import { ACTIVE_RUN_STATUSES } from './run-state.js';

/** True when an attempt is an interrupted side effect without a safe retry contract. */
function isUnsafeIncomplete(attempt) {
  if (!attempt) return false;
  const incomplete = attempt.status === 'started' || attempt.status === 'unknown';
  if (!incomplete || !attempt.sideEffects) return false;
  // Idempotent with a key, or already compensated, can be resumed safely.
  if (attempt.idempotent && attempt.idempotencyKey) return false;
  if (attempt.compensation && attempt.status === 'compensated') return false;
  return true;
}

export function computeRunMetrics(runs = []) {
  const list = Array.isArray(runs) ? runs : [];
  const total = list.length;
  const active = list.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).length;
  const succeeded = list.filter((r) => r.status === 'succeeded').length;
  const failed = list.filter((r) => r.status === 'failed').length;
  const cancelled = list.filter((r) => r.status === 'cancelled').length;
  const rolledBack = list.filter((r) => r.status === 'rolled_back' || r.status === 'rollback_required').length;
  const attempts = list.reduce((n, r) => n + (Array.isArray(r.attempts) ? r.attempts.length : 0), 0);
  const approvals = list.reduce((n, r) => n + (Array.isArray(r.approvals) ? r.approvals.length : 0), 0);
  const manualReview = list.reduce((n, r) => {
    const unsafe = Array.isArray(r.attempts) ? r.attempts.filter(isUnsafeIncomplete) : [];
    return n + (unsafe.length ? 1 : 0);
  }, 0);

  return {
    total,
    active,
    succeeded,
    failed,
    cancelled,
    rolledBack,
    attempts,
    approvals,
    manualReview,
    successRate: total ? succeeded / total : 0,
    failureRate: total ? failed / total : 0,
    rollbackRate: total ? rolledBack / total : 0,
  };
}

/**
 * Evaluate operational alerts. `auditOk` is the result of auditVerify().ok.
 * Thresholds are overridable; defaults are conservative starting points.
 */
export function evaluateAlerts(metrics = {}, { auditOk = true, thresholds = {} } = {}) {
  const t = {
    rollbackRate: thresholds.rollbackRate ?? 0.1,
    failureRate: thresholds.failureRate ?? 0.2,
    manualReview: thresholds.manualReview ?? 0,
  };
  const alerts = [];
  if (!auditOk) {
    alerts.push({ severity: 'critical', code: 'audit_chain_broken', message: 'audit log failed hash-chain verification' });
  }
  if ((metrics.manualReview ?? 0) > t.manualReview) {
    alerts.push({ severity: 'high', code: 'manual_review_required', message: `${metrics.manualReview} run(s) require manual review for an unsafe interrupted side effect` });
  }
  if ((metrics.rollbackRate ?? 0) > t.rollbackRate) {
    alerts.push({ severity: 'high', code: 'elevated_rollback_rate', message: `rollback rate ${(metrics.rollbackRate * 100).toFixed(1)}% exceeds ${(t.rollbackRate * 100).toFixed(1)}%` });
  }
  if ((metrics.failureRate ?? 0) > t.failureRate) {
    alerts.push({ severity: 'medium', code: 'elevated_failure_rate', message: `failure rate ${(metrics.failureRate * 100).toFixed(1)}% exceeds ${(t.failureRate * 100).toFixed(1)}%` });
  }
  return alerts;
}
