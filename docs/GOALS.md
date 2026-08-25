# Remote Agent: Product and Engineering Goals

> Status: working strategy, not a promise of completed functionality. The enterprise engine has durable run/device/JIT/upgrade/evidence primitives, SIEM NDJSON export, a JSON-safe admin API, signed plugin manifests, and a signed marketplace-index trust primitive. Production signing certificates, an authenticated admin-console transport/UI, hosted marketplace distribution, and cross-platform acceptance infrastructure remain operational work outside this repository.
>
> Repository reviewed at `SHA256:jgWTvgWUi0Eb3t9pBsJvP0CbQfPKcXTIMjTopJL0Nn4` and cross-checked against the repository roadmap and architecture review.

## North star

Remote should become **the trusted execution and governance layer for AI-operated work**: AI may inspect and act across laptops, servers, cloud infrastructure, and business systems, while local policy, human approval, verification, and an attributable audit trail remain authoritative.

This is deliberately stronger and more defensible than positioning the product as a general computer assistant. The repository already has a credible foundation: a thin device agent, a cloud control path, bounded execution, sandboxed tools, policy checks, memory, scheduling, multi-device claiming, local/BYO execution paths, and streamed auditability. The work now is to convert those mechanisms into a focused product with durable enterprise trust and measurable outcomes.

## Honest baseline

The repository is not yet a complete enterprise control plane or a finished general-purpose agent framework. Some capabilities are shipped, some are mid-migration, and some are roadmap claims. In particular, signed command/replay protection, stronger deny-by-default policy, complete tool output validation, robust subprocess isolation/cancellation, unified transport adapters, general task recovery, and enterprise fleet lifecycle need explicit implementation and verification before they should be marketed as complete.

The first commercial wedge should be **AI IT operations**, with AI SRE as the adjacent expansion. This uses what Remote already does well—local diagnostics and controlled remediation—without requiring the entire general-purpose agent market to be won at once.

## Goal 1 — Prove one painful outcome: governed AI IT operations

**Objective:** Make Remote reliably resolve a narrow set of endpoint and service incidents with less human effort and a clear safety record.

**Initial runbooks:** disk full, high CPU, service down, certificate expiry, broken VPN, developer-environment setup, and safe device onboarding/offboarding.

**Acceptance measures:**

- 5–10 design partners or internal pilot teams.
- At least 20 documented runs per runbook.
- Every run records diagnosis, proposed action, authorization, execution, verification, and outcome.
- Measure resolution rate, human intervention rate, time to resolution, rollback rate, policy blocks, and cost per successful run.
- No claim of autonomous remediation until verification and rollback behavior are tested under failure.

**First implementation areas:** `packages/engine`, tool policy modules, task queue/control path, and a versioned `docs/runbooks/` catalogue.

## Goal 2 — Finish the local trust boundary before adding autonomy

**Objective:** Ensure a compromised or malicious control plane cannot exceed the device’s locally enforced authority.

**Priority work:**

- Deny-by-default, schema-validated local policy with immutable, versioned bundles.
- Explicit tool capability and side-effect metadata.
- Validated tool outputs, redaction, per-invocation cancellation, resource/time limits, and stronger subprocess isolation.
- Signed command/task envelopes, nonces, replay cache, correlation IDs, idempotency keys, and bounded inbound queues.
- Tests for prompt injection, malicious tool output, SSRF, path/symlink escapes, secret exposure, confused deputy behavior, and compromised cloud requests.

**Likely implementation areas:** `packages/engine/src/policy.js`; `apps/desktop/src/tools/index.js`, `tools/shell.js`, `tools/files.js`, `tools/net.js`, `control.js`; security and integration/chaos tests.

**Acceptance evidence:** red-team and fuzz tests demonstrate that cloud intent cannot widen local policy; all decisions are audited; duplicate or forged commands are rejected; unsafe subprocesses are cancelled or contained.

## Goal 3 — Make execution durable, resumable, and verifiable

**Objective:** Turn the bounded loop into a durable state machine rather than relying on conversational continuity.

**Required states:** `created`, `queued`, `planning`, `awaiting_approval`, `executing`, `verifying`, `paused`, `retrying`, `completed`, `failed`, and `cancelled`.

**Required run data:** run ID, idempotency key, checkpoint, retry history, tool metadata, approval events, cancellation state, recovery point, and correlation ID.

**Safety contract:** inspect → plan → authorize → execute → verify → rollback or escalate. Tool metadata must describe idempotency, side effects, timeout, and compensation/rollback support.

**Acceptance measures:**

- A process interruption can resume from a safe checkpoint without duplicating non-idempotent actions.
- A failed verification creates an explicit failed/escalated result, never a false success.
- Cancellation, backpressure, duplicate delivery, and retry behavior are covered by offline and chaos tests.

## Goal 4 — Stabilize the public framework and tool SDK

**Objective:** Make the engine and tool registry a supported platform, not an internal collection of evolving files.

**Build next:**

- One documented public entry point and export contract.
- Schema-checked `defineTool` registry with output validation, capabilities, timeouts, concurrency, redaction, version/conflict policy, and lifecycle semantics.
- Complete TypeScript declarations, typed examples, compatibility guarantees, migration policy, and contract tests.
- Install and run an external tool from `examples/tools/hello` without editing the core registry.

**Likely implementation areas:** `packages/engine/src/index.mjs`, `apps/desktop/src/tools/define.js`, `registry.js`, `index.js`, `types/index.d.ts`, `types/index.test-d.ts`, `docs/TOOLS.md`, and `docs/STABILITY.md`.

**Acceptance evidence:** a third-party tool installs, passes policy and schema checks, survives version negotiation, and is covered by SDK/TypeScript tests.

## Goal 5 — Unify transport and deployment modes

**Objective:** Make cloud WebSocket, HTTPS polling, local/BYO provider, self-hosted, and MCP execution paths conform to one explicit adapter contract.

**Build next:**

- Extract transport interfaces and unify normal and Docker envelopes.
- Health state, reconnect/circuit-breaker behavior, bounded queues, signed transport, replay protection, and idempotent delivery.
- Integration fixtures for drop, delay, duplication, reordering, malformed frames, and offline recovery.
- Accurate support matrix for macOS, Linux, WSL2, Windows, Docker, and edge targets; remove claims that are not tested and released.

**Likely implementation areas:** `apps/desktop/src/transport/`, `cloud.js`, `control.js`, `packages/protocol/src/index.mjs`, installer/service files, and deployment docs.

**Acceptance evidence:** every supported transport passes the same protocol and failure-injection suite; offline/BYO operation is documented and reproducible.

## Goal 6 — Build an enterprise device and tenant control plane

**Objective:** Evolve the cloud side from task routing into an accountable fleet platform without weakening the open-source local agent.

**Milestones:**

1. Organizations, teams, projects/environments, strict tenant isolation, quotas, and retention controls.
2. SSO/OIDC/SAML, SCIM, MFA enforcement, RBAC/ABAC, service accounts, short-lived device credentials, rotation, and just-in-time access.
3. Device enrollment, groups/tags, health and last-seen state, agent version inventory, capability discovery, staged upgrades, rollback, and quarantine.
4. Cloud, dedicated/private, self-hosted, and offline/air-gapped deployment boundaries with explicit data-flow documentation.

**Acceptance measures:** tenant isolation and authorization tests; device credential revocation/rotation tests; staged rollout can pause and roll back; documented data residency and retention behavior.

## Goal 7 — Support Windows safely across actively supported releases

**Objective:** Make Windows a first-class supported endpoint platform without weakening the security boundary or promising unsupported legacy systems.

**Support policy:**

- Support only Windows versions that are within Microsoft’s active security-support lifecycle at release time.
- Track Microsoft lifecycle dates in a versioned support matrix and CI configuration.
- “All Windows versions” means all currently supported Windows editions/releases that satisfy the published prerequisites—not every historical Windows release.
- Do not support end-of-life Windows versions for production use. A compatibility mode may exist for evaluation only, must be clearly marked unsupported, and may be disabled when security controls cannot be guaranteed.
- Require current cumulative security updates, supported architecture, secure transport, and a supported PowerShell/runtime baseline.
- Define an end-of-support process with advance notice, last-compatible agent version, upgrade guidance, and emergency security cutoff where necessary.

**Implementation areas:**

- Native Windows service lifecycle, clean install/uninstall, upgrade, rollback, and recovery.
- Windows credential protection using Credential Manager/DPAPI or an equivalent OS-backed secret store; never plaintext provider keys.
- Windows Event Log integration, service hardening, least-privilege account, ACLs, and executable/signature verification.
- PowerShell and process execution with explicit argv/argument handling, constrained capabilities, job objects, cancellation, timeouts, and environment scrubbing.
- Windows filesystem, reparse-point/symlink, ACL, path normalization, and junction escape tests.
- Windows Firewall/network posture documentation and outbound-only connectivity verification.
- CI coverage for every supported Windows release/architecture and representative Server editions.
- Signed MSI/MSIX or equivalent installer, signed updates, provenance, SBOM, and rollback validation.

**Acceptance evidence:** each supported release passes install, upgrade, policy, filesystem, process, network, cancellation, audit, and uninstall tests; unsupported releases are blocked or clearly labelled; lifecycle metadata is reviewed every release.

## Goal 8 — Make audit evidence trustworthy and useful

**Objective:** Extend the existing hash-chained local audit concept into verifiable enterprise evidence.

**Required attribution:** actor, agent/model, device, policy version, approver(s), tool, before/after state where safe, correlation ID, timestamps, and outcome.

**Build next:** central append-only storage, cryptographic verification, retention/legal hold controls, export APIs, and SIEM integrations beginning with one high-value target (for example Splunk or Microsoft Sentinel).

**Acceptance measures:** an auditor can reconstruct a run end-to-end; tampering is detectable; exports preserve verification metadata; sensitive values are redacted before model context and external export.

## Goal 9 — Productize local policy as AI action governance

**Objective:** Make the local device policy the final authority and expose it as an explainable, testable product surface.

**Policy dimensions:** tool permissions, command allowlists, file scopes, network destinations, data classifications, roles, device groups, time windows, rate limits, budgets, environment restrictions, and break-glass procedures.

**Build next:**

- Policy-as-code schema with versioning and signed bundles.
- Visual policy editor in the control plane.
- Dry-run and policy simulation: “would this action be allowed, for which devices, and why?”
- Policy diff, regression tests, blast-radius preview, and Git pull-request workflow.
- Clear denial explanations that never leak sensitive data.

**Acceptance measures:** every tool call has a recorded decision; the same policy evaluator is used by local enforcement and simulation; policy changes are reviewable and reversible.

## Goal 10 — Build a safe, certified integration ecosystem

**Objective:** Turn the tool SDK into a platform with compatibility and trust signals rather than an unbounded collection of connectors.

**Initial integrations:** GitHub, Jira/ServiceNow, Slack, Kubernetes, AWS/Azure/GCP, one monitoring system, and one SIEM.

**Every tool package declares:** schema/version, capabilities, side effects, idempotency, approvals, data handling, compatibility, maintainer identity, and security-review status.

**Acceptance measures:** SDK contract tests, compatibility guarantees, certification checklist, signed releases, and a public catalogue separating read-only, production-safe, destructive, and sensitive-data tools.

## Goal 11 — Measure customer value, not token activity

**Objective:** Make the economic case legible to operators and executives.

**Dashboard metrics:** incidents resolved, mean time to resolution, hours saved, intervention rate, policy blocks, failed actions, rollbacks, approval latency, run success rate, risk exposure, and cost per successful workflow.

**Acceptance measures:** every pilot has a baseline and a review cadence; metrics are derived from immutable run events rather than vanity counters; pricing can be tied primarily to managed devices, successful workflows, governance, retention, and support—not raw tokens alone.

## Goal 12 — Earn trust before scaling claims

**Objective:** Treat security and compliance as product requirements and distribution advantages.

**Sequence:** signed/reproducible releases and SBOM → independent threat-model review and penetration test → SOC 2 readiness → ISO 27001/GDPR controls → vertical requirements such as HIPAA, PCI, or FedRAMP only when a real target customer justifies them.

**Honest rule:** documentation, badges, and roadmap items must be labelled separately from independently verified controls. “Compliant” is not a substitute for evidence. Keep supported-version tables and platform claims current.

## Goal 13 — Create an adoption and developer loop

**Objective:** Keep the local daemon genuinely useful on its own while making shared governance and fleet outcomes compelling upgrades.

**Developer surface:** stable protocol, TypeScript/Python SDKs, CLI, mock devices, local test harness, policy simulator, workflow debugger, traces, webhooks/event streams, Terraform provider, GitHub Actions, and Kubernetes deployment/operator support as demand proves out.

**Distribution:** open-source local adoption → runbook/tool contributions → team governance → enterprise fleet, audit, and private deployment. Do not hide basic local utility behind the cloud; trust depends on the open-source promise remaining real.

## Sequenced plan

### Next 90 days

- Confirm AI IT operations as the beachhead with interviews and design partners.
- Publish a Windows support and lifecycle matrix; begin Windows CI and native service/install work.
- Inventory actual versus documented capabilities; remove or qualify unsupported platform claims.
- Run the full test suite and record a baseline.
- Specify trust-boundary, transport, durable-run, idempotency, verification, and approval contracts.
- Ship the first three runbooks with failure-injection tests.
- Define policy-as-code v1 and a CLI dry-run/simulation prototype.
- Add outcome events and a pilot metrics report.

### 3–12 months

- Local trust-boundary hardening, signed commands, replay protection, and stronger process controls.
- Durable resumable runs and approval workflows.
- Stable public SDK and certified external tools.
- Fleet enrollment/groups/health and credential rotation.
- Central audit verification plus one SIEM export.
- Tenant isolation, RBAC, and SSO foundation.
- 10–20 certified integrations/runbooks.
- Security review and SOC 2 readiness work.

### 12–24 months

- Dedicated/self-hosted/private deployment options.
- Staged fleet upgrades and quarantine.
- Policy UI, GitOps review, simulation, and blast-radius analysis.
- Marketplace/runbook distribution with certification.
- ROI analytics and channel/design-partner expansion.

### 24–48 months

- AI SRE and security-operations packs.
- Cross-device execution graphs.
- Autonomous remediation only where evidence supports it.
- Embedded execution infrastructure and strategic partnerships.

## Decision rules

1. Prefer a narrow, measurable workflow over a broad undifferentiated assistant feature.
2. Local policy beats remote intent.
3. Never retry a non-idempotent side effect without an explicit recovery strategy.
4. Never let untrusted content become authority merely because a model saw it.
5. Never present aspirational compliance, platform support, or autonomy as shipped.
6. Every meaningful action must be attributable, reviewable, and verifiable.
7. Model-agnostic deterministic controls are the moat; model quality is replaceable.
8. If a feature cannot improve safety, reliability, adoption, or measurable customer outcome, defer it.
