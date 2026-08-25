# Mona Agent Project Plan

This is the execution bridge between [`GOALS.md`](GOALS.md) (strategy) and [`SPEC.md`](SPEC.md) (engineering specification). It is intentionally honest: `planned` is not `shipped`.

The sections below are named workstreams rather than “goals”; each workstream should be implemented, tested, and committed independently.

## Status legend

- **Now** — actively implement or validate.
- **Next** — start after the dependency is green.
- **Later** — valuable, but not a current commitment.
- **Evidence required** — do not market as complete without tests, logs, or external verification.

## Now: trust boundary and first wedge

### P0 — Ground-truth audit and product honesty

**Supports:** IT operations, trust boundary, and assurance.

- [ ] Run the complete test suite and record the baseline.
- [ ] Reconcile package versions and platform claims.
- [ ] Map exported functions and security-sensitive flows in `docs/AUDIT.md`.
- [ ] Mark documented, shipped, tested, and aspirational capabilities separately.
- [ ] Define the AI IT operations pilot and its success baseline.

**Exit evidence:** reproducible test report, reviewed audit, and at least one pilot workflow with before/after metrics.

### P1 — Local policy authority and command integrity

**Supports:** policy governance and execution security; SPEC sections 2 and P0/P1 work packages.

- [ ] Make signed/versioned local policy authoritative over remote requests.
- [ ] Add replay protection and correlation IDs to command/task envelopes.
- [ ] Test hostile control-plane requests, policy widening attempts, SSRF, path escapes, and secret exposure.
- [ ] Add policy explainability and a CLI dry-run before building a full UI.

**Exit evidence:** red-team tests demonstrate that cloud intent cannot exceed local policy and that replay/tampering is rejected.

### P2 — Durable, verifiable run state

**Supports:** durable execution and recovery.

- [ ] Specify and implement explicit run states and transitions.
- [ ] Persist checkpoints, idempotency keys, approval events, retries, cancellation, and recovery points.
- [ ] Add tool metadata for side effects, idempotency, timeouts, and compensation.
- [ ] Implement inspect → plan → authorize → execute → verify → rollback/escalate for the first runbooks.

**Exit evidence:** interruption/restart and failed-verification tests pass without duplicate unsafe side effects.

### P3 — Three IT operations runbooks

**Supports:** the initial IT operations wedge.

Start with the least ambiguous, most measurable workflows:

1. Disk-full diagnosis and approved cleanup.
2. Service-down diagnosis and approved restart.
3. Certificate-expiry inspection and approved renewal/escalation.

- [ ] Version each runbook.
- [ ] Add policy and approval requirements.
- [ ] Add positive, negative, timeout, and rollback tests.
- [ ] Capture outcome events and human intervention.

**Exit evidence:** 20+ recorded test/pilot runs with verified outcomes per runbook before any autonomy claim.

## Next: make the product adoptable by teams

### P4 — Public tool and workflow SDK

**Supports:** the public SDK and integration platform; SPEC sections 2/3.

- [ ] Stabilize schemas and protocol compatibility.
- [ ] Document tool package metadata: capabilities, side effects, idempotency, approvals, data handling, compatibility, maintainer.
- [ ] Provide local mocks, certification tests, and a compatibility policy.
- [ ] Build the first integrations around the IT wedge: monitoring, ticketing, Slack, and one cloud provider.

**Exit evidence:** third-party tool can be developed, tested, installed, policy-evaluated, and upgraded without editing core registry files.

### P5 — Fleet, identity, and Windows endpoint foundation

**Supports:** fleet and identity operations.

- [ ] Device enrollment and revocation.
- [ ] Groups/tags, capability discovery, health, last-seen, and agent version inventory.
- [ ] Short-lived credentials and rotation.
- [ ] Tenant boundaries, RBAC, and SSO/OIDC foundation.
- [ ] Staged upgrades, rollback, and quarantine design.
- [ ] Publish a Windows support matrix tied to Microsoft active security-support dates.
- [ ] Support every currently supported Windows release/edition selected for the product, including representative Windows Server releases, rather than historical end-of-life versions.
- [ ] Ship signed Windows installer and updates, native service lifecycle, OS-backed credential storage, Event Log integration, least privilege, ACL/reparse-point protections, and PowerShell/process cancellation controls.
- [ ] Add Windows CI for installation, upgrade, rollback, policy, filesystem, process, network, audit, and uninstall behavior.
- [ ] Block or clearly label unsupported/EOL Windows versions; never recommend insecure production deployment on them.

**Exit evidence:** authorization/isolation tests plus a repeatable enrollment-to-revocation lifecycle; every published Windows version passes the platform suite and lifecycle metadata is reviewed each release.

### P6 — Central audit and operator value

**Supports:** audit evidence and measurable customer value.

- [ ] Centralize verifiable run events while preserving local evidence.
- [ ] Add actor/device/policy/approver/tool attribution and safe before/after state.
- [ ] Implement retention, export, and one SIEM integration.
- [ ] Report resolution rate, MTTR, hours saved, policy blocks, rollbacks, approval latency, intervention rate, and cost per successful run.

**Exit evidence:** pilot operator and executive can reconstruct a run and explain its value from the same evidence set.

## Later: platform scale after the wedge works

### P7 — Enterprise control-plane deployment modes

- [ ] Organizations, tenants, teams, projects, environments, quotas, and strict tenant isolation.
- [ ] SAML/OIDC SSO, SCIM provisioning, MFA enforcement, RBAC/ABAC, service accounts, JIT access, and credential rotation.
- [ ] Approval workflows: single/two-person, role-based, expiring, escalation, and break-glass with complete attribution.
- [ ] Dedicated/private control plane, self-hosted deployment, air-gapped/offline operation, regional data residency, and customer-managed keys.
- [ ] Disaster recovery, backup/restore, RPO/RTO targets, incident response, support SLAs, and tenant deletion/export.

- [ ] Dedicated/private control plane.
- [ ] Self-hosted deployment.
- [ ] Air-gapped/offline operation.
- [ ] Regional data residency and customer-managed keys where justified by demand.

### P8 — Certified ecosystem, supply chain, and marketplace

- [ ] Signed tool/runbook packages with provenance and permission manifests.
- [ ] Review badges with explicit scope and expiry.
- [ ] Public catalogue and version compatibility.
- [ ] CI matrix, pinned actions, artifact signing, SBOM, provenance, dependency scanning, and release rollback.
- [ ] Marketplace economics only after SDK adoption and support burden are understood.

### P9 — Adjacent vertical packs

- [ ] AI SRE.
- [ ] Security operations.
- [ ] Compliance evidence collection.
- [ ] Cross-device execution graphs.

Autonomous remediation expands only where verification data supports it.

## Weekly operating review

For each active item, record:

- owner
- code/docs link
- dependency
- test or customer evidence
- security impact
- metric moved
- decision: continue, narrow, defer, or rollback

## Non-negotiables

1. Local policy beats remote intent.
2. No non-idempotent retry without recovery semantics.
3. No silent execution or false success.
4. No unsupported platform/compliance/autonomy claims.
5. Every meaningful action is attributable and auditable.
6. Preserve useful open-source local operation.
7. Prefer evidence from real runs over roadmap language.
8. Support Windows releases only while they receive active security updates; lifecycle status is a release gate.
9. Never normalize EOL operating systems as secure production targets.
