# Security Self-Audit Guide

A practical checklist for teams adopting remote-agent. Each item states what to
verify and where the evidence lives.

## 1. Device provisioning

- [ ] Device token generated from the dashboard (Settings → Remote key), never
      hardcoded, never committed to version control.
- [ ] `remote-agent login` performed on the device; credentials file readable
      only by the owning user (`chmod 600`).
- [ ] Device inventory matches reality: one token per device, labels in use.

## 2. Network posture

- [ ] No inbound ports required or opened for the daemon.
- [ ] Egress limited to `https://remoteagent.online` (and the LLM providers,
      which the *cloud* calls — the device never talks to providers).
- [ ] Corporate proxy/MITM inspection excluded for the cloud endpoint
      (certificate verification is enforced).

## 3. Secrets & keys

- [ ] Provider keys stored only via the dashboard (encrypted AES-256-GCM).
- [ ] Keys rotated on personnel change; last-used timestamps reviewed
      periodically.
- [ ] Device tokens revoked immediately on device loss (single-click).

## 4. Tool policy

- [ ] Policy file exists and is reviewed: `remote-agent policy status`
      (or `cat ~/.remote-agent/policy.json`).
- [ ] A preset is applied deliberately — `strict` for unattended
      machines, `standard` for human-supervised, `permissive` never for
      high-stakes devices.
- [ ] Shell allowlist reviewed (`REMOTE_ALLOW_CMDS`); blocked patterns and
      the argv execution model understood (no command string ever reaches
      a shell; every segment is allowlisted).
- [ ] For high-stakes devices: tools reduced to the minimum set; irreversible
      actions require human confirmation in the dashboard.
- [ ] Rate limits set per tool (`rateLimits` in the policy file) where
      blast radius matters.

## 5. Monitoring & incident response

- [ ] Live log reviewed (Logs tab) or exported for SIEM ingestion.
- [ ] Local audit chain verified regularly: `remote-agent audit verify`
      (fails on any tampering) and `remote-agent audit tail` for recent
      decisions.
- [ ] Retention period defined for audit data (cloud + device).
- [ ] Incident reconstruction drill: open a run trace and confirm the full
      chain (reasoning → tool call → result → answer → verification) is
      readable end-to-end; confirm the matching local audit entries exist.

## 6. Updates

- [ ] Release tags pinned; changelog reviewed before rollout.
- [ ] Staging device tests a new version before fleet rollout.
- [ ] Red-team suite green on staging: `npm test` (includes
      `test/security.test.mjs` — 58 adversarial cases).

## Evidence matrix

| Control | Evidence |
|---|---|
| Authentication | Settings → Devices: token list with last-used |
| Authorization | Rate-limit events in the live log; plan limits in Settings → Plan; local policy denials in `remote-agent audit tail` |
| Integrity | Git tags; test suite in CI (unit + security); dependency list (see `SBOM.md`); `remote-agent audit verify` |
| Confidentiality | Key storage is encrypted server-side; devices hold no provider keys; child processes get a scrubbed environment |
| Auditability | History tab, run traces, JSONL training export, live event stream, hash-chained local audit log |
