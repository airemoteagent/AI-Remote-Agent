# Compliance Roadmap — remote-agent v4.0.0

> **Owner:** Product Security & Compliance · **Status:** active · **Target release:** v4.0.0
> This document is the single source of truth for the v4.0.0 compliance and
> intelligence release. It defines measurable goals, the phased plan, and the
> acceptance criteria that gate each phase. Progress is tracked against the
> artefacts listed here, never against prose alone.

---

## 1. Purpose

Turn remote-agent from a **technically well-tested but informally documented**
product into a product with a **formal, auditable security & compliance posture**:

1. **IEC 62443** — treat the device daemon as an IACS component and demonstrate
   conformance to the *secure product development lifecycle* (IEC 62443-4-1) and
   the *technical component requirements* (IEC 62443-4-2).
2. **EU Cyber Resilience Act (CRA)** — demonstrate readiness for Regulation
   (EU) 2024/2847: secure by design, SBOM, vulnerability handling, security
   updates, coordinated disclosure, and the technical-documentation basis.
3. **Enterprise-grade documentation** — every control, requirement and decision
   is traceable from *requirement → design → test evidence*.
4. **Smarter, more intuitive agent** — additive intelligence/UX improvements
   that never regress the existing 451-test green suite.

> **Honesty rule (unchanged):** these artefacts document *implemented and tested*
> controls and *readiness*. Formal IEC 62443 certification and a CRA conformity
> assessment require an independent body; this repository supplies the evidence
> base and the process documentation they need, and states plainly what remains
> external work (hardware-backed key storage, hosted SSO/SCIM, independent audit).

---

## 2. North star

**The trusted execution & governance layer for AI-operated work**, where local
policy, human approval, verification, and an attributable audit trail remain
authoritative — and where that authority is *provable* through traceable
security requirements, not asserted.

---

## 3. Goals

### G1 — Revision & single source of truth
Bring every version reference to **4.0.0** and eliminate metadata drift.

- Root package.json, apps/desktop/package.json, packages/engine,
  CITATION.cff, sbom.cyclonedx.json, apps/desktop/src/version.js all agree.
- CHANGELOG.md follows Keep a Changelog exactly (single Unreleased section,
  no duplicate sections, test counts match reality).
- **Acceptance:** a grep for "3.0.0" (excluding node_modules) returns no stale
  product version; "npm test" reports the exact count stated in README/CHANGELOG.

### G2 — IEC 62443-4-1 secure development lifecycle (SDLC)
Document the product SDLC and map it to the 13 process requirements (SM-1…SM-13).

- Deliver docs/IEC-62443-4-1.md with a requirement-by-requirement mapping to
  the actual repo process (threat model, secure design, secure implementation,
  security testing, issue management, update management, third-party components,
  security guidelines, product documentation).
- **Acceptance:** every SM-1…SM-13 row cites a concrete artefact and test path.

### G3 — IEC 62443-4-2 technical component requirements
Map the 7 foundational requirements (FR 1–7) and their component requirements
(CRs) to implemented controls and tests.

- Deliver docs/IEC-62443-4-2.md expanding the existing FR table with CR-level
  traceability (IAC, UC, SI, DC, RDF, TRE, RA) and security-level rationale.
- **Acceptance:** every FR cites design + test evidence; residual risks listed.

### G4 — EU Cyber Resilience Act (CRA)
Document CRA Annex I (Part I security properties + Part II vulnerability
handling), Annex II (information & instructions), and the manufacturer
obligations (Art. 13) and exploited-vulnerability reporting (Art. 14).

- Deliver docs/CRA-COMPLIANCE.md replacing the lightweight readiness note.
- **Acceptance:** each Annex I(1)-(9) item maps to an implemented control;
  each Part II(1)-(7) item maps to a process; ENISA reporting timelines stated.

### G5 — Traceability & evidence
Produce a requirements-traceability matrix linking security requirements to
design modules and test files, plus a vulnerability-management process.

- Deliver docs/SECURITY-REQUIREMENTS-TRACEABILITY.md and
  docs/VULNERABILITY-MANAGEMENT.md.
- **Acceptance:** an auditor can follow any headline security claim to a test file.

### G6 — Compliance index
Deliver docs/COMPLIANCE-MATRIX.md as the master index tying every framework
and control to its evidence, and rewrite docs/COMPLIANCE.md as the entry point.

### G7 — Smarter, more intuitive agent (additive)
Improve reasoning context, tool ergonomics, and operator experience without
regression:

- Sharper tool schemas/descriptions for more reliable model tool use.
- Better error/denial messages (explain *why*, without leaking secrets).
- One high-value operator feature (health/doctor deepening or a diagnostic aid).
- **Acceptance:** "npm test" stays 451+ green; new tests added for new behaviour.

---

## 4. Compliance scope & dependencies

| Framework | Scope | Deliverable |
|---|---|---|
| IEC 62443-4-1 | Secure product development lifecycle (process) | docs/IEC-62443-4-1.md |
| IEC 62443-4-2 | Technical component security requirements | docs/IEC-62443-4-2.md |
| EU CRA (2024/2847) | Product + vulnerability handling + documentation | docs/CRA-COMPLIANCE.md |
| Supporting (context) | ISO 27001 Annex A, GDPR, EU AI Act, NIS2 | existing docs, cross-linked |
| Evidence | Requirement → design → test | docs/SECURITY-REQUIREMENTS-TRACEABILITY.md |

---

## 5. Phased plan

### Phase 0 — Ground truth (this release)
- [x] Baseline the repository (451 tests green, ~29 s, exit 0).
- [x] Inventory existing compliance documents and drift.
- [x] Fix version/metadata drift (G1).

### Phase 1 — Compliance documentation core
- [ ] IEC 62443-4-1 SDLC mapping (G2)
- [ ] IEC 62443-4-2 technical mapping (G3)
- [ ] CRA compliance document (G4)

### Phase 2 — Traceability & processes
- [ ] Requirements-traceability matrix (G5)
- [ ] Vulnerability-management & disclosure process (G5)
- [ ] Master compliance matrix + index (G6)

### Phase 3 — Intelligence & UX (additive)
- [ ] Tool schema/description improvements (G7)
- [ ] Denial/error message improvements (G7)
- [ ] Operator feature + tests (G7)

### Phase 4 — Verification & sign-off
- [ ] Full "npm test" green, new tests included
- [ ] Version/metadata consistency sweep
- [ ] Oversight checker final report clean

---

## 6. Decision rules (non-negotiables)

1. Local policy beats remote intent — never weaken the trust boundary.
2. No runtime dependencies added; ws stays the only one.
3. Never retry a non-idempotent side effect without an explicit recovery path.
4. Never present aspirational compliance, platform support, or autonomy as shipped.
5. Every meaningful action attributable, reviewable, verifiable.
6. Every compliance claim maps to a test file or an auditable artefact.
7. Model-agnostic deterministic controls are the moat; model quality is replaceable.
8. Additive changes only where they risk regressing the green suite.

---

## 7. Version & release strategy

- **4.0.0** — compliance documentation foundation + additive intelligence work.
- Semantic versioning per docs/STABILITY.md; CHANGELOG is Keep-a-Changelog.
- Release evidence: source archive + SHA256SUMS + sbom.cyclonedx.json
  + provenance (per existing release.yml).

---

## 8. Status

Tracked in goal goal-a2f40ff6-41c4-426a-8cb9-7aa22e65431f.
This document is a living artefact and is updated as each goal is delivered.
