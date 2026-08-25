# Compliance & Standards Readiness

mona-agent is the open-source client for the mona.expert cloud. This document
summarizes how the architecture maps to common compliance frameworks. Detailed
mappings live in the sibling documents of this folder.

Architecture in one paragraph: a lightweight device daemon holds **no secrets
and no model weights**; it authenticates to the cloud over TLS with a single
device key, polls for work, receives reasoning decisions from the cloud brain,
executes tools locally behind an allowlist, and streams results back. All LLM
provider keys are stored AES-256-GCM encrypted on the server, never on the
device. Every run is audit-logged with per-step usage, tokens, cost and timing.

## Framework alignment at a glance

| Framework | Scope | How mona-agent aligns |
|---|---|---|
| **EU CRA** (Cyber Resilience Act) | Products with digital elements | SBOM-ready, signed releases, documented vulnerability handling, secure-by-default device, free security updates for the support window — see `CRA-READINESS.md` |
| **ISO/IEC 27001** | Information security management | Documented controls mapping (Annex A), crypto, access control, logging, incident handling — see `ISO-27001-MAPPING.md` |
| **IEC 62443** | OT / industrial automation security | The daemon as an embedded device component: least privilege, no default credentials, integrity checks, patch path — see `IEC-62443.md` |
| **NIS2 / KRITIS** | Critical infrastructure operators | Operator-side documentation: inventory, incident reporting hooks, supply-chain data |
| **GDPR** | Personal data | Data minimization (device metrics only), user-scoped data isolation, export & deletion endpoints, encryption at rest for secrets |
| **SOC 2** (Type II readiness) | Trust services criteria | Audit trail completeness, access controls, change management evidence, availability monitoring |

## Security properties that matter for auditors

1. **No inbound ports on devices.** The daemon polls HTTPS every 2 s. Nothing
   can reach the device from the internet.
2. **One key, one brain.** The device key proves device identity; LLM provider
   keys live encrypted on the server and are never shipped to devices.
3. **TLS everywhere.** All control and data traffic is HTTPS with certificate
   verification (no TLS bypass, no insecure fallback).
4. **Tool sandboxing.** Shell execution is argv-based (never a shell
   string): every executable is realpath-resolved and allowlisted, chains
   and pipes re-check each segment, and the child environment is scrubbed.
   File access is confined to a workspace root with path-traversal,
   symlink-escape and TOCTOU rejection; deletes move to trash. Network
   access is SSRF-safe — private ranges, loopback and cloud metadata are
   unreachable.
5. **Complete audit trail.** Every chat message, brain step, tool call,
   tool result, token count, cost and latency is stored and exportable
   (JSONL) — including per-step reasoning for incident reconstruction. On
   the device, every policy decision is additionally appended to a
   hash-chained, tamper-evident local audit log (`mona-agent audit verify`).
6. **Self-healing operation.** Transient failures retry with backoff, malformed
   brain replies trigger corrective nudges, stranded tasks expire with a
   closing message instead of replaying days later.
7. **Rate limiting & plan separation.** Free and Pro plans enforce request
   limits per user and per device; the local policy engine adds per-tool
   rate limits that the control plane cannot override.
8. **Local policy is authoritative.** `~/.mona-agent/policy.json`
   (allow/deny/confirm, presets, rate limits) is loaded from disk at
   startup — a compromised or malicious control plane can request, but
   the device decides.

## Useful reading

- `THREAT-MODEL.md` — STRIDE analysis of the cloud-brain architecture
- `DATA-FLOW.md` — where data lives, moves, and is minimized
- `SECURITY-AUDIT.md` — self-assessment checklist for adopters
- `DEPLOYMENT-GUIDE.md` — enterprise rollout (launchd/systemd, proxies, updates)
- `ENTERPRISE-FAQ.md` — procurement questions and answers
