# Implementation Backlog

This backlog turns the repository assessment into deliverable work. It is ordered by risk reduction and customer evidence, not by feature breadth. Each item has an explicit completion signal.

## Status (main, commit `38ffa36`)

This status was refreshed after the security-hardening commits. The repository contains implementation and tests for cryptographic device enrollment, versioned policy controls, tenant-aware fleet administration, artifact checksum verification, prompt-injection trust-boundary guidance, and review/distribution workflows.

Implemented and tested in `packages/engine/src` (all committed with unit tests):

- **P0.1 Durable run lifecycle** — `run-state.js`: recovery points, rollback, cancel, resume, bounded retries, safe retry decisions.
- **P0.2 Honest capability status** — capability matrix in `README.md` (unchanged, still authoritative).
- **P0.3 Repeatable release evidence** — SBOM/SHA256/provenance in `.github/workflows/release.yml`; added CodeQL + secret scan + reproducibility gate in `ci.yml`.
- **P1.4 / Goal 7 supply-chain** — `plugin-manifest.js`: Ed25519 signing/verification + deny-by-default capabilities.
- **P2.1 Device & identity lifecycle** — `device-registry.js`: Ed25519 identity generation, signed enrollment, tenant binding, fingerprints, credential issuance/expiration/revocation/rotation, health, tenant isolation; `jit.js`: role-scoped JIT access. Hardware-backed storage and hosted OIDC/SCIM remain external work.
- **P2.2 Central evidence & value metrics** — `evidence.js` (run reconstruction + audit export), `metrics.js` (value metrics + alerts).
- **Goal 6 deployment** — `upgrade.js` (health-gated staged rollout), `package-lifecycle.js` (install/upgrade/rollback).
- **Integration** — `fleet.js` composes the above into one operator entry point; `admin-api.js` supplies a JSON-safe control-plane boundary.
- **Goal 7 marketplace trust primitive** — `marketplace-index.js`: deterministic Ed25519-signed plugin index that verifies the publisher index and every included plugin manifest fail-closed.
- **Goal 8 SIEM exporter** — `siem.js`: NDJSON audit/evidence export with hash-chain verification, metrics, and alerts.
- **Lifecycle acceptance** — CI dry-runs the Linux and Windows installers and runs the package lifecycle state-machine acceptance test.

Remaining: configure real Authenticode and GPG signing credentials in GitHub Actions secrets (P1.3), deploy an authenticated admin-console transport/UI, and implement a hosted marketplace distribution service. These require operational credentials and infrastructure and are intentionally not fabricated in source control.

## P0 — Trust foundation

### P0.1 Durable run lifecycle and recovery

**Goal:** no side-effecting action is silently duplicated or lost after interruption.

- Define persisted run states: `created`, `planned`, `awaiting_approval`, `running`, `verifying`, `succeeded`, `failed`, `cancelled`, `rollback_required`, and `rolled_back`.
- Persist an immutable run id, correlation id, policy revision, plan revision, checkpoint data, approvals, tool attempt history, verification result, and recovery decision.
- Require an idempotency key for every side-effecting tool invocation; reject unsafe retry when no recovery/compensation contract exists.
- Add restart, cancellation, timeout, approval-expiry, policy-narrowing, and partial-failure tests.

**Done when:** an interrupted run resumes or fails safely without duplicating a side effect, demonstrated by automated end-to-end tests.

### P0.2 Honest capability status

**Goal:** users can distinguish shipped local features from experimental, planned, and cloud-dependent behavior.

- Maintain the capability matrix in [README.md](../README.md).
- Keep roadmap-only claims out of the "Available now" category.
- Link each externally visible capability to test evidence or a supporting document.

**Done when:** every headline capability has a status and an evidence link.

### P0.3 Repeatable release evidence

**Goal:** a release is test-gated and consumers can verify what they downloaded.

- Run the test suite, type declaration tests, and dependency audit before release publication.
- Generate a source archive, SHA-256 checksum, SBOM, and build provenance attestation.
- Publish a verification command in release notes or release documentation.

**Done when:** a tagged release cannot publish without required checks and includes verifiable artifacts.

## P1 — Operations wedge

### P1.1 Three verifiable runbooks

Deliver versioned, policy-gated runbooks for:

1. disk-full diagnosis and approved cleanup;
2. service-down diagnosis and approved restart;
3. certificate-expiry inspection and approved renewal or escalation.

Each runbook must define prerequisites, policy/approval rules, verification criteria, recovery behavior, and a rollback/escalation path.

**Done when:** each has positive, denial, timeout, failed-verification, and recovery tests plus 20 recorded pilot or fixture runs.

### P1.2 End-to-end acceptance environments

Build reproducible fixtures for disk pressure, a failed service, expiring certificates, interrupted runs, and policy revocation.

**Done when:** Linux, macOS, and each supported Windows target run the relevant acceptance suite, with artifacts retained by CI.

### P1.3 Windows operational support

- Publish the supported Windows and Windows Server matrix with lifecycle dates.
- Add signed installer/update artifacts, service lifecycle, credential storage, Event Log integration, least-privilege ACL/reparse-point controls, and install/upgrade/rollback/uninstall tests.

**Done when:** every declared Windows target passes its lifecycle and security acceptance tests.

### P1.4 Supply-chain and plugin trust

- Add CodeQL/SAST, secret scanning, dependency review, release attestations, and artifact signing.
- Establish signed tool packages with capability/permission manifests, provenance, compatibility rules, and certification tests before expanding third-party plugins.

**Done when:** every release and installable extension has machine-verifiable provenance and documented verification steps.

### P1.5 Maintainability refactor

Split the current high-change modules into bounded components without behavior changes:

- task orchestration, context construction, and audit reporting from `apps/desktop/src/agent.js`;
- CLI command handlers from `apps/desktop/bin/mona-agent.js`;
- state/rendering from `apps/desktop/src/tui.js`;
- parser/execution/policy portions of `apps/desktop/src/tools/shell.js`;
- validation/matching/decision portions of `packages/engine/src/policy.js`.

**Done when:** each extracted component has an explicit API, dedicated tests, and no regression in the full suite.

## P2 — Team and enterprise foundations

### P2.1 Device and identity lifecycle

Implement enrollment, revocation, short-lived credentials, rotation, inventory, health/last-seen, groups/tags, tenant isolation, and RBAC/OIDC.

**Done when:** automated tests cover enrollment-to-revocation and cross-tenant authorization isolation.

### P2.2 Central evidence and value metrics

Centralize verifiable run evidence while retaining the local chain. Include actor, device, policy, approver, tool, before/after state, retention/export, and one SIEM integration. Measure successful resolution rate, MTTR, hours saved, policy blocks, rollbacks, approval latency, intervention rate, and cost per successful run.

**Done when:** an operator can reconstruct an entire run and an executive can view value metrics from the same evidence.

## Explicitly deferred

Marketplace expansion, broad autonomous remediation, and new vertical packs remain deferred until durable execution and the three IT-operations runbooks have evidence of safe, repeatable outcomes.
