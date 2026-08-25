# Security Policy

mona-agent is a client for the mona.expert cloud. This document describes
the client-side security model and how to report vulnerabilities.

## Supported versions

| Version | Supported |
|---|---|
| 2.x (current) |  |
| < 2.0 |  |

## Security model

- **No AI provider keys on the device.** The client stores only a
  mona.expert device token (`~/.mona-agent/credentials.json`, mode 0600).
  All third-party keys live in the cloud vault, AES-256 encrypted.
- **Local policy is authoritative.** `~/.mona-agent/policy.json` governs
  every tool call (allow / deny / confirm / rate limits). The control plane
  can never modify or widen it — it is loaded once from disk at startup.
  `mona-agent policy explain <tool>` shows which rule fired.
- **Shell: argv execution, never a shell string.** Commands are parsed into
  argv arrays; every executable is realpath-resolved and allowlisted;
  chains and pipes re-check each segment; redirects and command
  substitution are rejected. Child processes get a scrubbed environment.
- **SSRF-safe networking.** DNS is resolved by the agent, every address is
  checked against blocked ranges, redirects are re-validated per hop, and
  cloud metadata endpoints are blocked by name and IP.
- **Confined file tool.** Reads/writes confined to the workspace with
  symlink-escape and traversal guards, `O_NOFOLLOW` + descriptor checks
  (TOCTOU), special files refused, deletes go to trash by default.
- **Tamper-evident audit log.** Every policy decision is appended to
  `~/.mona-agent/audit.jsonl`, hash-chained and append-only. Verify with
  `mona-agent audit verify`.
- **Egress-only networking.** The daemon opens outbound connections only
  and listens on localhost exclusively (for the local dashboard). No
  inbound ports, no public exposure.
- **Metrics minimization.** Only system metrics and requested results are
  sent, only to the cloud endpoint you configured (`MONA_CLOUD`).
- **Transparent transport.** HTTPS with Bearer-auth; WebSocket upgrade when
  available, HTTPS polling fallback otherwise.

## Verified guarantees (red-team suite)

Every security claim above maps to an automated adversarial test in
`apps/desktop/test/security.test.mjs` — command injection, allowlist
bypass, pipe-to-shell, path traversal, symlink escape, SSRF (incl. DNS
rebinding simulation and redirect-to-metadata), FIFO/device refusal,
audit-chain tampering, rate limits. Run with `npm test`.

## Deprecations

- `MONA_SHELL_UNSAFE=1` — deprecated in v2.8.0. Use
  `{"shell": {"unsafe": true}}` in `~/.mona-agent/policy.json` instead
  (audited). Removed in v3.0.

## Reporting a vulnerability

**Do not open a public issue for security bugs.** This repository does not use a public issue as the intake channel for suspected vulnerabilities.

Please report privately first so we can fix before disclosure:

1. Email: `security@mona.expert` (use an encrypted channel when appropriate).
2. Include a safe subject, affected version/commit and component, impact, and concise reproduction steps. Attach only sanitized logs or proof-of-concept material; never include real credentials or customer data.
3. Tell us whether the issue is being actively exploited, whether you want credit, and your preferred disclosure timeline. We will acknowledge within 48 hours and aim to publish a fix + advisory within 14 days, extending the timeline collaboratively when needed.
4. If you do not receive an acknowledgment within 3 business days, follow up through the contact listed in the repository metadata rather than opening a public issue.

For review planning, hardening suggestions, and non-sensitive documentation gaps, use the [security review template](.github/ISSUE_TEMPLATE/security-review.yml) or the scope checklist in [docs/SECURITY-REVIEW-SCOPE.md](docs/SECURITY-REVIEW-SCOPE.md).

### Disclosure policy

- 48 h — acknowledgment
- 14 days — fix + coordinated disclosure (extendable on request)

### Vulnerability handling (CRA-aligned)

- Every report is triaged by severity within 48 h
- Fixes ship with an advisory; exploited vulnerabilities are reported to
  ENISA / competent authorities as required
- Dependency surface is tracked via the [SBOM](docs/SBOM.md)
  (`sbom.cyclonedx.json`)
- Security updates install with one command
  (`curl -fsSL https://agent.mona.expert/install.sh | bash`)

## Compliance

- [docs/COMPLIANCE.md](docs/COMPLIANCE.md) — CRA, NIS2, AI Act, GDPR
- [docs/AI-ACT.md](docs/AI-ACT.md) — AI Act transparency record
- [docs/GDPR.md](docs/GDPR.md) — privacy & data processing
- [docs/SBOM.md](docs/SBOM.md) — software bill of materials

## Hall of fame

We appreciate all responsible disclosures. With your permission, we list
contributors here.
