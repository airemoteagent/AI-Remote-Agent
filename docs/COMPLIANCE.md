# Compliance & Trust

remote-agent and the remoteagent.online cloud are designed with the modern EU
regulatory landscape in mind. This document summarises our position for
each framework: what applies, what is in place today, and how it maps to
the product.

> Transparency note: the statements below describe **readiness and
> alignment**, not third-party certifications. Where a formal audit,
> certification or conformity assessment applies to your use case, it is
> performed in the context of the remoteagent.online cloud service.

## Frameworks at a glance

| Framework | Scope | Applies to | Position |
|---|---|---|---|
| **EU Cyber Resilience Act (CRA)** | Products with digital elements | remoteagent.online cloud (SaaS) | Readiness program in place — SBOM, vulnerability handling, coordinated disclosure, secure-by-design development |
| **NIS2 Directive** | Network & information systems security | Essential / important entities | Supports customer obligations — logging, TOMs, incident assistance |
| **EU AI Act** | AI systems | remote-agent + engine (limited risk) | Transparency obligations implemented; documentation below |
| **GDPR** | Personal data | remoteagent.online cloud | Privacy by design, data minimisation, DPA-ready documentation |

## Cyber Resilience Act (CRA)

The CRA requires products with digital elements to be secure by design,
shipped with vulnerability handling processes, security updates, and
documentation — and to report exploited vulnerabilities to ENISA.

- **Open-source client (remote-agent)** — free, MIT-licensed, supplied
  outside commercial activity: outside the CRA's main obligations. We
  still apply the same discipline: secure defaults, dependency
  minimisation, coordinated disclosure.
- **remoteagent.online cloud (the SaaS)** — treated as in scope. Readiness
  elements in place:
  - **SBOM** — see [SBOM.md](SBOM.md) (`sbom.cyclonedx.json`); one runtime
    dependency (`ws`), updated continuously.
  - **Vulnerability handling** — [SECURITY.md](../SECURITY.md): 48 h
    acknowledgment, 14-day fix + coordinated disclosure, ENISA-style
    reporting path (`security@remoteagent.online`).
  - **Secure by design / by default** — AES-256-GCM encryption at rest
    for all stored keys, TLS in transit, least-privilege tool sandbox,
    no inbound ports on devices.
  - **Security updates** — the client updates in place with a single
    command; the cloud ships continuously.
  - **Documentation & conformity** — this document set + risk controls
    below.

## NIS2

NIS2 applies to **essential and important entities** (energy, transport,
health, digital infrastructure, etc.). remoteagent.online is not classified as
such today — but we build so that NIS2 customers can meet their own
duties when using us:

- **Risk management** — documented TOMs (technical and organisational
  measures): encryption, access control, monitoring, backup.
- **Supply chain security** — minimal dependencies, pinned versions,
  dependency review on change.
- **Incident handling** — severity-based response, 48 h triage,
  customer notification, audit trail of every action
  (`mona_audit_log`).
- **Logging & detection** — per-user audit log, rate limiting,
  anomaly-friendly telemetry.

## EU AI Act

See the dedicated [AI Act documentation](AI-ACT.md). Summary: remote-agent
is a **limited-risk** AI system (agent assistant / device automation).
Transparency obligations (disclosure of AI interaction, documentation,
logging, human oversight) are implemented. We are not a general-purpose
model provider; the remoteagent.online engine orchestrates third-party models
on behalf of the user.

## GDPR

See the dedicated [GDPR documentation](GDPR.md). Summary: data
minimisation by design (metrics only, no key material on devices),
AES-256 vault, documented processing purposes, retention limits, and a
prepared data-processing annex for customers.

## Security measures (TOMs)

| Domain | Measure |
|---|---|
| Encryption at rest | AES-256-GCM vault for all API keys and tokens |
| Encryption in transit | HTTPS/TLS for every connection; no plaintext endpoints |
| Access control | Per-user bearer tokens, session auth, CSRF protection, per-user rate limits |
| Least privilege | Device tool sandbox — argv-based allowlisted shell, SSRF-safe network, confined file roots, egress-only networking |
| Logging & audit | Immutable-style audit log of agent actions, LLM calls, key events + tamper-evident hash-chained local audit (`remote-agent audit verify`) |
| Resilience | Stateless API, automatic reconnect, HTTP fallback channel, 180-point device history |
| Incident response | [SECURITY.md](../SECURITY.md) — 48 h acknowledgment, coordinated disclosure, advisory publishing |

## Certifications roadmap

Formal attestations are tracked for the remoteagent.online cloud. Planned:
SOC 2 Type I (process documentation first), ISO/IEC 27001 alignment
(reuse of the controls above), and CRA conformity assessment once the
delegated acts finalise. The open-source client itself remains
certification-free by design (MIT, minimal surface).

## Questions

Compliance questions: `compliance@remoteagent.online`.
Security issues: `security@remoteagent.online` (see [SECURITY.md](../SECURITY.md)).
