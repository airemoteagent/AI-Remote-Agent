# Compliance & Trust

remote-agent and the remoteagent.online cloud are designed with the modern EU
regulatory landscape in mind. This document is the **entry point**; the master
index with control-to-evidence links lives in `docs/COMPLIANCE-MATRIX.md`.

> Transparency note: the statements below describe **readiness and alignment**,
> not third-party certifications. Where a formal audit, certification or
> conformity assessment applies, it is performed in the context of the
> remoteagent.online cloud service.

## Frameworks at a glance

| Framework | Scope | Applies to | Position |
|---|---|---|---|
| **EU Cyber Resilience Act (CRA)** | Products with digital elements | remoteagent.online cloud (SaaS) | Readiness + evidence — `docs/CRA-COMPLIANCE.md` |
| **IEC 62443-4-1** | Secure product development lifecycle | remote-agent (IACS component) | Process mapping — `docs/IEC-62443-4-1.md` |
| **IEC 62443-4-2** | Technical component requirements | remote-agent (IACS component) | CR mapping — `docs/IEC-62443-4-2.md` |
| **NIS2 Directive** | Network & information systems security | Essential / important entities | Supports customer obligations — logging, TOMs, incident assistance |
| **EU AI Act** | AI systems | remote-agent + engine (limited risk) | Transparency obligations — `docs/AI-ACT.md` |
| **GDPR** | Personal data | remoteagent.online cloud | Privacy by design — `docs/GDPR.md` |

## Cyber Resilience Act (CRA)

Full mapping: `docs/CRA-COMPLIANCE.md`. Summary: secure by design, SBOM,
vulnerability handling, coordinated disclosure, security updates, and the
technical-documentation basis (Annex I/II, Art. 13/14). The open-source client
is outside the main obligations (Art. 3); the SaaS is in scope.

## IEC 62443

Full mapping: `docs/IEC-62443-4-1.md` (SDLC, SM-1…SM-13) and
`docs/IEC-62443-4-2.md` (technical FR 1–7 / CRs). The daemon is treated as an
unprivileged, egress-only IACS component with least-privilege tools, no default
credentials, integrity-checked updates, and a hash-chained audit trail.

## NIS2

NIS2 applies to essential and important entities. remoteagent.online is not
classified as such today — but we build so NIS2 customers can meet their own
duties: documented TOMs, minimal dependencies, severity-based incident response,
and a complete audit trail of every agent action.

## EU AI Act

remote-agent is a **limited-risk** AI system. Transparency obligations are
implemented and documented in `docs/AI-ACT.md`.

## GDPR

Data minimisation by design (metrics only, no key material on devices),
AES-256 vault, documented purposes, retention limits, and a DPA annex. See
`docs/GDPR.md`.

## Security measures (TOMs)

| Domain | Measure |
|---|---|
| Encryption at rest | AES-256-GCM vault for all API keys and tokens |
| Encryption in transit | HTTPS/TLS for every connection; no plaintext endpoints |
| Access control | Per-user bearer tokens, session auth, CSRF protection, per-user rate limits |
| Least privilege | argv-based allowlisted shell, SSRF-safe network, confined files, egress-only |
| Logging & audit | Immutable-style cloud audit + hash-chained local audit (`remote-agent audit verify`) |
| Resilience | Stateless API, automatic reconnect, HTTP fallback, device history |
| Incident response | `SECURITY.md` + `docs/VULNERABILITY-MANAGEMENT.md` (SLAs, CVD) |

## Process & evidence

- `docs/COMPLIANCE-ROADMAP.md` — goals, plan, decision rules.
- `docs/SECURITY-REQUIREMENTS-TRACEABILITY.md` — SR-1…SR-13 → module → test.
- `docs/VULNERABILITY-MANAGEMENT.md` — issue handling, SLAs, Art. 14 timelines.
- `docs/additional-documents/THREAT-MODEL.md` — STRIDE + abuse scenarios.

## Certifications roadmap

Formal attestations are tracked for the remoteagent.online cloud. Planned: SOC 2
Type I, ISO/IEC 27001 alignment, IEC 62443-4-1 component assessment, and CRA
conformity assessment once the delegated acts finalise. The open-source client
itself remains certification-free by design (MIT, minimal surface).

## Questions

Compliance questions: `compliance@remoteagent.online`.
Security issues: `security@remoteagent.online` (see `SECURITY.md`).
