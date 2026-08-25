# Security Review Scope and Checklist

**Status:** Review-ready planning artifact. This is a scope and checklist, not an audit report or claim that a review has occurred.

## Purpose

Give maintainers and independent reviewers a repeatable, evidence-oriented way to assess the client. Reviewers should record findings, test limits, versions, and evidence in their own report.

## In scope

- **Trust boundaries:** cloud control plane, local daemon, CLI/TUI, localhost dashboard, child processes, filesystem workspace, credentials, and third-party services.
- **Policy enforcement:** allow/deny/confirm decisions, rate limits, startup loading, policy explainability, and attempts to widen policy remotely.
- **Command execution:** argv parsing, executable resolution and allowlists, pipes/chains/redirections/substitution, environment scrubbing, timeouts, and platform-specific behavior.
- **Filesystem:** workspace confinement, traversal and symlink escapes, TOCTOU defenses, descriptor handling, special files, trash/delete behavior, permissions, and sensitive-file exposure.
- **Networking:** URL parsing, DNS resolution and rebinding, blocked ranges/metadata endpoints, redirect revalidation, TLS/authentication, proxy behavior, egress-only claims, and localhost exposure.
- **Secrets and data:** credential permissions, token lifecycle, logs/metrics/telemetry minimization, cloud-vault boundaries, error messages, and accidental disclosure.
- **Protocol and control plane:** authentication, authorization, replay/freshness, message validation, WebSocket/polling fallback, reconnect behavior, and malformed input handling.
- **Updates and distribution:** installer integrity, update authorization/rollback, package provenance, lockfile/dependency changes, release artifacts, SBOM, and platform installers.
- **Prompt/tool safety:** untrusted content boundaries, tool authorization, prompt injection resistance, delegation/workflow controls, and confirmation UX.

## Out of scope unless explicitly added

Cloud/server implementation, infrastructure, account recovery, legal/compliance certification, availability/load testing, physical compromise, and social engineering. Note any assumptions about the SaaS boundary.

## Reviewer setup and evidence

Record commit SHA/tag, OS and version, Node/npm versions, installation path, configuration/policy fixtures, test commands, network assumptions, and tool versions. Never include real credentials or customer data. Use synthetic fixtures and redact logs, tokens, and personal data.

## Checklist

### Reconnaissance

- [ ] Map entry points, privileged operations, trust boundaries, and data flows.
- [ ] Identify security-sensitive dependencies and review lockfile/provenance.
- [ ] Confirm documented behavior against implementation and tests.
- [ ] Define a clean-room test account and disposable workspace.

### Hostile-input testing

- [ ] Test malformed, oversized, duplicated, replayed, and unexpected protocol messages.
- [ ] Test command metacharacters, Unicode/normalization, NULs, shell-like syntax, PATH confusion, and symlink races.
- [ ] Test URL schemes, credentials, encoded IPs, DNS changes, redirects, IPv4/IPv6, and metadata aliases.
- [ ] Test untrusted tool output and prompt-injection strings reaching model/delegation paths.
- [ ] Test policy bypasses through retries, reconnects, alternate clients, workflows, and plugins.

### Authorization and isolation

- [ ] Verify every sensitive operation has an explicit policy decision and least privilege.
- [ ] Verify remote control cannot widen local policy or bypass confirmation/rate limits.
- [ ] Verify credentials, audit logs, workspace files, child processes, and tenants are isolated.
- [ ] Verify localhost services bind as documented and reject unintended origins/peers.

### Resilience and observability

- [ ] Exercise timeouts, cancellation, partial writes, reconnects, crashes, and disk-full/read-only cases.
- [ ] Confirm failures do not leak secrets and audit records remain tamper-evident.
- [ ] Confirm security events are actionable without collecting unnecessary content.
- [ ] Add regression tests for each confirmed issue and preserve a reproduction fixture.

## Finding record template

For each finding capture: title, severity and rationale, affected commit/version, preconditions, concise reproduction, expected vs actual behavior, impact, evidence (sanitized), suggested remediation, and regression-test plan. Separate confirmed vulnerabilities from hardening suggestions and documentation gaps.

## Exit criteria

A review is complete only when the reviewer has delivered a dated report covering the agreed scope, limitations, findings, evidence, and retest status. Maintainers must not describe this checklist as an audit or certification.

## Maintainer handoff

- Provide the reviewer a pinned commit and reproducible setup instructions.
- Triage privately through the process in [`SECURITY.md`](../SECURITY.md).
- Track fixes and retests by issue/advisory IDs; do not publish exploit details before coordinated disclosure.
- Update this scope when architecture, distribution, or threat assumptions materially change.
