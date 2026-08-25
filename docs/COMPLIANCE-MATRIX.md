# Master Compliance Matrix & Documentation Index

> **Purpose:** the single entry point linking every compliance framework, control
> and artefact in this repository to its evidence. Start here for any audit or
> due-diligence review.

---

## 1. Frameworks at a glance

| Framework | Scope | Primary document | Status |
|---|---|---|---|
| EU Cyber Resilience Act (2024/2847) | Products with digital elements | docs/CRA-COMPLIANCE.md | Readiness & evidence |
| IEC 62443-4-1 | Secure product development lifecycle | docs/IEC-62443-4-1.md | Evidence-based alignment |
| IEC 62443-4-2 | Technical component requirements | docs/IEC-62443-4-2.md | Evidence-based alignment |
| ISO/IEC 27001 | ISMS Annex A controls | docs/additional-documents/ISO-27001-MAPPING.md | Control mapping |
| EU AI Act | Limited-risk transparency | docs/AI-ACT.md | Transparency obligations |
| GDPR | Personal data processing | docs/GDPR.md | Privacy by design |
| NIS2 | Essential/important entities | docs/COMPLIANCE.md | Operator support |

---

## 2. Document map

Governance & process:
- docs/COMPLIANCE-ROADMAP.md - goals, phased plan, decision rules (v4.0.0).
- docs/VULNERABILITY-MANAGEMENT.md - issue handling, SLAs, CVD, Art. 14 timelines.
- SECURITY.md - public disclosure policy + contact.
- docs/.well-known/security.txt - machine-readable reporting.

Requirements & traceability:
- docs/SECURITY-REQUIREMENTS-TRACEABILITY.md - SR-1..SR-13 -> module -> test.
- docs/IEC-62443-4-1.md - SM-1..SM-13 process mapping.
- docs/IEC-62443-4-2.md - FR 1-7 / CR mapping.
- docs/CRA-COMPLIANCE.md - Annex I/II + Art. 13/14 mapping.

Architecture & security:
- docs/ARCHITECTURE.md - design + trust boundary.
- docs/additional-documents/THREAT-MODEL.md - STRIDE + abuse scenarios.
- docs/additional-documents/DATA-FLOW.md - data inventory & minimization.
- docs/POLICY.md - policy grammar + presets.
- docs/additional-documents/SECURITY-AUDIT.md - adopter checklist.

Supply chain & operations:
- docs/SBOM.md + sbom.cyclonedx.json - bill of materials.
- docs/RELEASE-DISTRIBUTION-CHECKLIST.md - release verification.
- docs/PLUGIN-SUPPLY-CHAIN.md - plugin signing & marketplace trust.
- docs/RUNBOOKS.md - operational runbooks.

Deployment & platform:
- docs/DEPLOYMENT-GUIDE.md, docs/WINDOWS.md, docs/DEVICE-LIFECYCLE.md.
- docs/SLA-DR-BC.md - service levels, DR, business continuity.

---

## 3. Control evidence (headline)

| Control | Evidence |
|---|---|
| Local policy authoritative | policy.js + policy-rules.test.mjs + security.test.mjs |
| argv-only shell | tools/shell.js + system-cmd.test.mjs |
| Workspace-confined files | tools/files.js + tools-new.test.mjs |
| SSRF-safe network | tools/net.js + tools-new.test.mjs |
| Prompt-injection boundary | agent.js/loop.js + prompt-injection.test.mjs |
| Tamper-evident audit | policy.js auditWrite/Verify + security.test.mjs |
| Device identity (Ed25519) | device-registry.js + device-registry.test.mjs |
| Update integrity | update.js + update-integrity.test.mjs |
| Plugin supply chain | plugin-manifest.js + plugin-manifest.test.mjs |
| Durable runs | run-state.js + run-state.test.mjs / run-recovery.test.mjs |

---

## 4. Release verification (v4.0.0)

- Version: 4.0.0 (root, desktop, lock, CITATION.cff, SBOM agree).
- Tests: 451 passed, 0 failed (~29 s) - CI matrix Node 20/22/24 x 3 OS.
- Artefacts per release: source archive + SHA256SUMS + sbom.cyclonedx.json + provenance.
- Verify: sha256sum -c SHA256SUMS ; npm test ; npm audit --audit-level=high.

## 5. Honesty statement

These artefacts document implemented and tested controls and readiness. They do
not constitute an IEC 62443 certificate, a CRA conformity assessment, an
independent security audit, or any compliance certification. Certification and
conformity assessment are performed by accredited bodies in the context of the
in-scope commercial product. What remains external (hardware-backed key storage,
hosted SSO/SCIM, independent audit) is stated, not implied.
