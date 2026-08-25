# Operational SLAs, Disaster Recovery & Business Continuity

Covers monitoring, alerting, incident response, and operational commitments (Goal 8).

## Monitoring & alerting
1. Emit operational signals: agent heartbeat, run success/failure rate, policy blocks, rollback count, approval latency, and audit-chain integrity.
2. Alert on: audit-chain break, elevated policy-block rate, rollback/rollback-required runs, credential expiry, and device offline beyond threshold.
3. Every alert carries the run id and audit position where available, so an operator can reconstruct the incident from the durable ledger.

## Incident response
1. Triage by severity; any side-effecting failure enters the `recoverable()` review path (see `packages/engine/src/run-state.js`).
2. Unsafe interrupted side effects require `manual_review`; safe ones may `resume`.
3. Escalation follows `docs/RUNBOOKS.md` (stop at the boundary, escalate with evidence).

## Service-level objectives (initial targets)
| Signal | Target |
| --- | --- |
| Audit-chain integrity | 100% verifiable (`auditVerify` ok) |
| Unsafe duplicate prevention | 0 duplicated side effects |
| Recovery decision accuracy | 100% unsafe runs routed to manual review |
| Run evidence completeness | 100% of production runs retain id, policy revision, approval, attempts, verification |

These are starting objectives, not contractual SLAs; tune them after pilot telemetry.

## Disaster recovery & business continuity
1. The local durable run ledger (atomic 0600 writes) is the source of truth and must be backed up with the device.
2. RTO: restore the run ledger and policy within one hour of a device failure. RPO: no committed run state older than the last atomic write.
3. A tested restore procedure validates the audit chain after recovery (`auditVerify`).
4. BC plans cover: device loss, credential compromise, upstream service outage, and tenant data isolation breach.

**Done when:** a restore drill reconstructs a full run from backup and verifies the audit chain, and an operator can follow the escalation path end-to-end with retained evidence.
