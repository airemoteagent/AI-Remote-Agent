# EU Cyber Resilience Act (CRA) Readiness

The Cyber Resilience Act (EU) 2024/2847 imposes cybersecurity requirements on
products with digital elements sold in the EU. This document maps remote-agent's
client architecture to the CRA's essential requirements and manufacturer
obligations.

## Product classification

remote-agent (this repository) is **open-source software** distributed free of
charge as the client for a cloud service. Under CRA Article 3, open-source
software developed outside a commercial activity is exempt; the commercial
**cloud service** (remoteagent.online) is the product with digital elements and the
obligations below are documented so operators can show readiness end-to-end.

## Essential requirements (Annex I) — how they are met

| CRA requirement | Implementation |
|---|---|
| Security by design & default | No inbound ports, least-privilege tools, secure defaults, no credentials on devices |
| No known exploitable vulnerabilities at release | Automated test suite (unit + 58-case red-team suite), dependency audit in CI; patched releases published on GitHub |
| Secure default configuration | Allowlist-based argv shell execution (no string-to-shell), workspace-confined file access with TOCTOU guards, SSRF-safe networking, local policy with safe defaults |
| Protection against unauthorized access | Device key authentication (revocable per device), TLS 1.2+, AES-256-GCM encrypted keys |
| Data minimization | Only task text, tool results and device metrics leave the device; provider keys never reach devices |
| Resilience & availability | Self-healing agent loop, retry with backoff, stale-task expiry, metrics-driven health checks |
| Logging & monitoring | Complete audit trail (messages, brain steps, tool calls, tokens, cost, latency); live event stream; device-side hash-chained audit log |
| Secure updates | Versioned releases on GitHub; daemon restart applies updates; update notes in CHANGELOG |

## Manufacturer obligations — operational mapping

| CRA obligation | Where it happens |
|---|---|
| Vulnerability handling process | `SECURITY.md` (reporting, response targets, disclosure policy) + `security.txt` |
| Vulnerability reporting for components | Dependencies are audited; fixes released within the support window |
| SBOM (software bill of materials) | `docs/SBOM.md` — inventory of client components and versions |
| Support window & updates | Client follows semantic versioning with tagged releases; breaking changes documented in CHANGELOG |
| CE marking & technical documentation | Operator-side; this repository provides the technical documentation basis |

## Incident response & disclosure targets

- **Acknowledge** a valid report within 5 working days
- **Triage & reproduce** within 15 days
- **Fix or mitigate** within 90 days for high-severity issues
- **Disclose** publicly after a fix is available (coordinated disclosure)

See `SECURITY.md` at the repository root for the full policy and contact.
