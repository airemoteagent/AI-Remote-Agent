// Evidence reconstruction and audit export.
//
// buildRunEvidence turns a durable run into a complete, plain-JSON evidence
// bundle (run metadata, approvals, attempts, checkpoints, rollbacks, and the
// recovery decision) so an operator can reconstruct an entire run. readAuditEntries
// loads and verifies the hash-chained audit log, and queryAudit filters it for
// SIEM/dashboard export. Everything returns owned JSON — no live service state.

import { readFileSync, existsSync } from 'node:fs';
import { auditVerify } from './policy.js';

/** Reconstruct a complete, plain-JSON evidence bundle for one run. */
export function buildRunEvidence(runStore, runId) {
  const run = runStore.get(runId);
  if (!run) return null;
  const recovery = runStore.recoverable().find((r) => r.run.id === runId);
  return {
    run: {
      id: run.id,
      task: run.task,
      status: run.status,
      correlationId: run.correlationId,
      policyRevision: run.policyRevision,
      planRevision: run.planRevision,
      reason: run.reason,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    approvals: (run.approvals || []).map((a) => ({
      actor: a.actor, decision: a.decision, expiresAt: a.expiresAt, note: a.note, ts: a.ts,
    })),
    attempts: (run.attempts || []).map((a) => ({
      tool: a.tool, idempotencyKey: a.idempotencyKey, sideEffects: a.sideEffects,
      idempotent: a.idempotent, compensation: a.compensation, status: a.status,
      result: a.result, ts: a.ts, updatedAt: a.updatedAt,
    })),
    checkpoints: (run.checkpoints || []).map((c) => ({ index: c.index, ts: c.ts, data: c.data })),
    rollbacks: (run.rollbacks || []).map((r) => ({ ts: r.ts, fromIndex: r.fromIndex, toIndex: r.toIndex, reason: r.reason })),
    recovery: recovery ? { action: recovery.action, reason: recovery.reason } : null,
  };
}

/** Load audit entries and verify their hash chain. Returns owned JSON only. */
export function readAuditEntries(path) {
  if (!path || !existsSync(path)) return { entries: [], verification: { ok: true, checked: 0, brokenAt: null } };
  const verification = auditVerify(path);
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  return { entries, verification };
}

/** Filter audit entries by exact field matches (kind, tool, verdict, action). */
export function queryAudit(entries, filter = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((e) => {
    if (filter.kind !== undefined && e.kind !== filter.kind) return false;
    if (filter.tool !== undefined && e.tool !== filter.tool) return false;
    if (filter.verdict !== undefined && e.verdict !== filter.verdict) return false;
    if (filter.action !== undefined && e.action !== filter.action) return false;
    return true;
  });
}
