# EU Cyber Resilience Act (CRA) — Compliance Documentation

> **Standard:** Regulation (EU) 2024/2847 (Cyber Resilience Act) · **Status:** readiness & evidence
> This document replaces the lightweight `docs/additional-documents/CRA-READINESS.md` and
> maps the CRA's essential requirements, vulnerability-handling obligations, information
> duties and manufacturer obligations to implemented controls, processes and artefacts.

---

## 1. Scope & product classification

**Important, stated plainly:** under CRA Article 3, *open-source software supplied
outside the course of a commercial activity* is **not** a "product with digital
elements" and therefore **not** in scope for the CRA's conformity obligations.

- **remote-agent (this repository)** — free, MIT-licensed client: outside the main
  CRA obligations. We nonetheless apply the same discipline (secure defaults, SBOM,
  vulnerability handling, coordinated disclosure) because it is the foundation the
  commercial product builds on.
- **remoteagent.online cloud (the SaaS)** — the *product with digital elements*: **in
  scope**. The evidence below documents readiness for a conformity assessment once
  the relevant delegated acts and harmonised standards finalise.
- **When an operator commercialises remote-agent** (embeds it in a sold product or
  charges for it), that operator is the *manufacturer* under the CRA and assumes the
  obligations in §3–§6.

---

## 2. Essential requirements — Annex I, Part I

| # | CRA requirement | Implementation & evidence |
|---|---|---|
| (1) | Security by design & by default | Egress-only daemon, no inbound ports, least-privilege tool sandbox, no credentials on device; `docs/ARCHITECTURE.md`, `docs/IEC-62443-4-1.md` SM-3 |
| (2) | No known exploitable vulnerabilities at release | 451-test suite incl. red-team + `npm audit --audit-level=high` in CI; patched releases via `release.yml` |
| (3) | Secure default configuration | argv-only shell (no string-to-shell), workspace-confined files (O_NOFOLLOW/TOCTOU), SSRF-safe network, deny-by-default local policy |
| (4) | Protection against unauthorized access | Revocable per-device token + Ed25519 enrollment, TLS 1.2+, AES-256-GCM vault; `device-registry.js` |
| (5) | Data minimization | Only task text, tool results and device metrics leave the device; provider keys never reach devices; `docs/additional-documents/DATA-FLOW.md` |
| (6) | Availability & resilience | Self-healing loop, retry/backoff, stale-task expiry, bounded output, step budgets; health/metrics (`metrics.js`) |
| (7) | Attack-surface minimization | Tool allowlist + deny-by-default policy; one runtime dependency; plugins denied by default |
| (8) | Reduce impact of incidents | Process-group kill on timeout, per-tool timeouts, trash-based deletes, bounded context compaction, hash-chained audit for forensics |
| (9) | Security-related information (logging/monitoring) | Full audit trail (messages, brain steps, tool calls, tokens, cost, latency) + local hash-chained decision log + SIEM NDJSON export (`siem.js`) |

---

## 3. Vulnerability handling — Annex I, Part II

| # | CRA requirement | Implementation & evidence |
|---|---|---|
| (1) | Identify & document vulnerabilities and components | SBOM (`sbom.cyclonedx.json`); dependency audit; `docs/VULNERABILITY-MANAGEMENT.md` |
| (2) | Address vulnerabilities promptly | Response targets: acknowledge ≤ 48 h, triage ≤ 15 d, high-severity fix ≤ 90 d (`SECURITY.md`) |
| (3) | Test security updates before release | Regression + red-team suite per fix; reproducibility + checksum gates in CI |
| (4) | Inform users after a fix | Coordinated disclosure: advisory published when a fix is available (`SECURITY.md`) |
| (5) | Coordinated vulnerability disclosure (CVD) policy | `SECURITY.md` + `docs/.well-known/security.txt` + `security-review.yml` intake |
| (6) | Secure distribution of updates | SHA-256 verified self-update, `SHA256SUMS` + provenance on releases, checksum-enforced installers |
| (7) | Notify about available security updates | CHANGELOG advisories + update lifecycle record (`~/.remote-agent/update.json`) |

---

## 4. Information & instructions to the user — Annex II

| Annex II item | Where provided |
|---|---|
| Manufacturer name, address & contact | `CITATION.cff`, README, `remoteagent.online`, `compliance@remoteagent.online` |
| Description & security properties of the product | `docs/ARCHITECTURE.md`, `docs/COMPLIANCE.md`, this document |
| EU declaration of conformity / CE marking | Operator-side; this repository supplies the technical-documentation basis (Annex VII input) |
| Support period for security updates | `SECURITY.md` (support window), semver policy in `docs/STABILITY.md` |
| Instructions for secure use & configuration | `docs/POLICY.md`, `docs/SECURITY-AUDIT.md`, `docs/DEPLOYMENT-GUIDE.md` |
| How to report vulnerabilities | `SECURITY.md`, `security.txt`, `security@remoteagent.online` |
| SBOM / dependency information | `sbom.cyclonedx.json`, `docs/SBOM.md` |
| Guidance on receiving security updates | `remote-agent update`, `docs/RELEASE-DISTRIBUTION-CHECKLIST.md` |

---

## 5. Manufacturer obligations — Article 13

| Obligation | Evidence |
|---|---|
| Conformity assessment (Annex VI/VII) | Technical documentation basis (this set); operator completes for the SaaS |
| Technical documentation (Annex VII) | `docs/ARCHITECTURE.md` + `docs/additional-documents/THREAT-MODEL.md` + `DATA-FLOW.md` + SBOM + test evidence |
| CE marking & EU declaration of conformity | Operator-side |
| Support period & security updates | Documented support window; free security updates within it |
| Vulnerability handling & CVD | `docs/VULNERABILITY-MANAGEMENT.md`, `SECURITY.md` |
| Report exploited vulnerabilities (Art. 14) | ENISA/CSIRT reporting path defined (timelines below) |
| SBOM | `sbom.cyclonedx.json` (CycloneDX 1.5), regenerated per release |

---

## 6. Exploited-vulnerability reporting — Article 14

Mandatory reporting to the CSIRT and ENISA when a vulnerability is **actively
exploited** or a **severe incident** affects product security:

| Deadline | Report |
|---|---|
| **≤ 24 h** | Early warning (nature of exploitation, available mitigations) |
| **≤ 72 h** | Vulnerability notification (severity, impact, remediation, indicator of compromise) |
| **≤ 14 days** | Final report (root cause, fix, residual risk) |

These timelines are incorporated into `docs/VULNERABILITY-MANAGEMENT.md` and
`SECURITY.md` so the incident-response process is CRA-ready.

---

## 7. What is NOT claimed

- **No CE marking, no EU declaration of conformity** — those are issued by the
  operator/manufacturer of the in-scope product, not this repository.
- **No completed conformity assessment** — the harmonised standards and delegated
  acts are still being finalised; this set is the evidence base, not the assessment.
- **No independent security audit** yet (roadmap).

---

## 8. Cross-references

- `docs/COMPLIANCE-MATRIX.md` — master index.
- `docs/VULNERABILITY-MANAGEMENT.md` — issue handling process & SLAs.
- `docs/SECURITY-REQUIREMENTS-TRACEABILITY.md` — requirement → design → test.
- `docs/IEC-62443-4-1.md` / `docs/IEC-62443-4-2.md` — IEC 62443 alignment.
