# ISO/IEC 27001 Annex A — Control Mapping

This mapping supports organizations building an ISMS around the mona-agent
deployment. "Implemented by mona-agent/platform" means the control exists in
the product; "operator" means the adopting organization provides it.

## A.5 — Information security policies
- **A.5.1 Policies for information security** — operator. Templates: this
  repository's security documents are the baseline.

## A.8 — Asset management
- **A.8.1 Responsibility for assets** — operator assigns owners; the platform
  enumerates assets: users, agents, devices, API keys, tasks, runs.
- **A.8.2 Information classification** — task content is user-scoped; device
  telemetry is limited to performance metrics.

## A.9 — Access control
- **A.9.1 Business requirements** — device tokens are per-device, revocable
  (single revoke or revoke-all); dashboard uses Sngine session auth with CSRF
  protection on every state change.
- **A.9.2 User access management** — one key per device; keys are encrypted
  AES-256-GCM at rest on the server; last-used timestamps for review.
- **A.9.4 System and application access control** — role separation: device
  (Bearer token) vs dashboard (session) APIs; write operations rate-limited.

## A.10 — Cryptography
- **A.10.1 Cryptographic controls** — TLS for all transport; AES-256-GCM for
  stored secrets; random token generation (CSPRNG); no custom crypto.

## A.12 — Operations security
- **A.12.1 Operational procedures** — documented run loop (poll → claim →
  think → act → observe → reflect → answer → verify).
- **A.12.4 Logging and monitoring** — full audit log (messages, brain steps,
  tool calls, token usage, cost, latency), live event stream, trace endpoint
  per run; device-side hash-chained policy-decision log with integrity
  verification (`mona-agent audit verify`).
- **A.12.5 Control of operational software** — versioned, tagged releases;
  update via daemon restart; changelog maintained.
- **A.12.6 Technical vulnerability management** — SECURITY.md disclosure
  process; dependency reviews; coordinated disclosure; automated red-team
  suite in CI (`apps/desktop/test/security.test.mjs`).

## A.13 — Communications security
- **A.13.1 Network security management** — devices initiate all connections
  (no inbound exposure); certificate verification enforced.

## A.14 — System acquisition, development and maintenance
- **A.14.2 Security in development** — test suite on every change, parser
  fuzzing via unit tests, lint, secure-by-default tool registry.

## A.16 — Information security incident management
- **A.16.1 Responsibilities and procedures** — incident reconstruction from
  the audit trail and per-run traces; feedback loop documented in SECURITY.md.

## A.17 — Business continuity (information security aspects)
- **A.17.1 Planning** — operator; the client is stateless: any device can be
  reprovisioned with a new token without re-deploying infrastructure.

## A.18 — Compliance
- **A.18.1 Legal and contractual** — operator; data export and deletion
  endpoints exist (per-user factory reset, per-agent deletion, JSONL export).
