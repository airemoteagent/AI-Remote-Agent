# Security Requirements Traceability Matrix

> **Purpose:** link every headline security requirement to its **design module** and
> its **test evidence**, so an auditor can follow any claim end-to-end. Requirements
> are derived from `docs/additional-documents/THREAT-MODEL.md` (STRIDE) and
> `docs/IEC-62443-4-1.md` (SM-2).

| ID | Security requirement | Design module(s) | Test evidence |
|---|---|---|---|
| SR-1 | Local policy is authoritative — the control plane can never widen device authority | `packages/engine/src/policy.js`, `packages/engine/src/policy-registry.js`, `apps/desktop/src/tools/index.js` | `packages/engine/test/policy-rules.test.mjs`, `apps/desktop/test/security.test.mjs` |
| SR-2 | Shell executes argv arrays only — no user string ever reaches a shell; per-segment allowlist | `apps/desktop/src/tools/shell.js` | `apps/desktop/test/system-cmd.test.mjs`, `apps/desktop/test/security.test.mjs` |
| SR-3 | Files confined to workspace; path traversal / symlink / TOCTOU rejected | `apps/desktop/src/tools/files.js` | `apps/desktop/test/tools-new.test.mjs`, `apps/desktop/test/security.test.mjs` |
| SR-4 | SSRF-safe networking — DNS-pinned, CIDR-blocked, redirect re-validated, metadata blocked | `apps/desktop/src/tools/net.js` | `apps/desktop/test/tools-new.test.mjs`, `apps/desktop/test/security.test.mjs` |
| SR-5 | Prompt-injection trust boundary — untrusted web/file/email/plugin/tool content never becomes authority | `apps/desktop/src/agent.js` (context fenced), `packages/engine/src/loop.js` (normaliseToolResult) | `apps/desktop/test/prompt-injection.test.mjs` |
| SR-6 | Tamper-evident audit — hash-chained, append-only, verifiable | `packages/engine/src/policy.js` (auditWrite/auditVerify), `packages/engine/src/evidence.js` | `apps/desktop/test/security.test.mjs`, `packages/engine/test/evidence.test.mjs` |
| SR-7 | No secrets on device — scrubbed child env, no provider keys | `apps/desktop/src/tools/shell.js`, `apps/desktop/src/credentials.js` | `apps/desktop/test/credentials.test.mjs`, `apps/desktop/test/system-cmd.test.mjs` |
| SR-8 | Device identity & authentication — Ed25519 enrollment, revocable tokens, tenant isolation | `packages/engine/src/device-registry.js`, `packages/engine/src/jit.js`, `packages/engine/src/fleet.js`, `packages/engine/src/admin-api.js` | `packages/engine/test/device-registry.test.mjs`, `jit.test.mjs`, `fleet.test.mjs`, `admin-api.test.mjs` |
| SR-9 | Update integrity — SHA-256 verified, checksum-enforced, rollback-capable | `apps/desktop/src/update.js`, `apps/desktop/install.sh`, `install.ps1`, `packages/engine/src/upgrade.js` | `apps/desktop/test/update-integrity.test.mjs`, `packages/engine/test/upgrade.test.mjs` |
| SR-10 | Plugin supply chain — signed manifests, deny-by-default third-party tools | `packages/engine/src/plugin-manifest.js`, `marketplace-index.js`, `apps/desktop/src/tools/registry.js` | `packages/engine/test/plugin-manifest.test.mjs`, `marketplace-index.test.mjs`, `apps/desktop/test/plugin-tool.test.mjs` |
| SR-11 | Bounded execution — step budget, per-tool timeouts, output caps, process-group kill | `packages/engine/src/loop.js`, `apps/desktop/src/tools/index.js`, `apps/desktop/src/tools/shell.js` | `packages/engine/test/engine.test.mjs`, `apps/desktop/test/e2e-engine.test.mjs` |
| SR-12 | Durable, resumable runs — no duplicated side effects after interruption | `packages/engine/src/run-state.js`, `packages/engine/src/loop.js` (resume) | `packages/engine/test/run-state.test.mjs`, `run-recovery.test.mjs`, `loop-resume.test.mjs` |
| SR-13 | Data minimization & egress-only — device initiates, telemetry performance-only | `apps/desktop/src/control.js`, `apps/desktop/src/metrics.js`, `apps/desktop/src/cloud.js` | `apps/desktop/test/control.test.mjs`, `apps/desktop/test/metrics.test.mjs` |

## Coverage summary

- **13 security requirements**, each with a named design module and at least one test file.
- The red-team suites (`security.test.mjs`, `prompt-injection.test.mjs`, `system-cmd.test.mjs`)
  exercise SR-1…SR-7 adversarially; engine suites cover SR-8…SR-13.
- Full suite baseline: **451 tests, 0 failures** (CI: Node 20/22/24 × ubuntu/macos/windows).

## How to verify

1. Run the full suite: `npm test` (451 green).
2. Verify the local audit chain on a device: `remote-agent audit verify`.
3. Confirm release integrity: `sha256sum -c SHA256SUMS` and inspect `sbom.cyclonedx.json`.

## Cross-references

- `docs/COMPLIANCE-MATRIX.md` — master index across all frameworks.
- `docs/IEC-62443-4-1.md` / `docs/IEC-62443-4-2.md` — IEC 62443 mappings.
- `docs/CRA-COMPLIANCE.md` — EU Cyber Resilience Act.
