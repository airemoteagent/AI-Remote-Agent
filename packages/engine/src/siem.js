// SIEM / dashboard export.
//
// Turns the durable run ledger and verified audit log into newline-delimited
// JSON (NDJSON) for a SIEM, log pipeline, or dashboard. All output is owned
// JSON, and every audit export carries the hash-chain verification result so a
// consumer can reject tampered evidence.

import { readAuditEntries, queryAudit, buildRunEvidence } from './evidence.js';
import { computeRunMetrics, evaluateAlerts } from './metrics.js';
import { auditVerify } from './policy.js';

/** Serialise records to newline-delimited JSON (one JSON object per line). */
export function toNdjson(records = []) {
  return (Array.isArray(records) ? records : []).map((r) => JSON.stringify(r)).join('\n');
}

/**
 * Export filtered audit entries as NDJSON with the chain verification result.
 * `filter` is a { kind, tool, verdict, action } subset; omit to export all.
 */
export function exportAuditNdjson({ path, filter } = {}) {
  const { entries, verification } = readAuditEntries(path);
  const filtered = filter ? queryAudit(entries, filter) : entries;
  return { ndjson: toNdjson(filtered), count: filtered.length, verification };
}

/**
 * Export every run's evidence as NDJSON, followed by a summary line
 * (`_type: "summary"`) carrying run metrics and operational alerts.
 */
export function exportRunEvidenceNdjson(runStore) {
  const runs = runStore.list();
  const evidence = runs.map((r) => buildRunEvidence(runStore, r.id)).filter(Boolean);
  const metrics = computeRunMetrics(runs);
  const alerts = evaluateAlerts(metrics, { auditOk: auditVerify().ok });
  const lines = [
    ...evidence,
    { _type: 'summary', metrics, alerts },
  ];
  return { ndjson: toNdjson(lines), count: evidence.length, summary: lines[lines.length - 1] };
}
