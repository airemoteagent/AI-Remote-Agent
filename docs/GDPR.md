# GDPR — Privacy & Data Processing

How remoteagent.online processes personal data, and how the open-source client
minimises it. This document supports both end-user transparency
(Art. 13/14) and customer due diligence (Art. 28 annex-ready).

## Roles

- **remoteagent.online** — data controller for account data; data processor
  where customers operate the platform on their own behalf.
- **You (the user)** — controller of your own device and of the
  commands you issue.

## Processing activities (Art. 30 summary)

| Purpose | Categories | Legal basis | Retention |
|---|---|---|---|
| Account & authentication | Email, username, API token, session | Contract (Art. 6(1)(b)) | Account lifetime + 30 days |
| Agent operation & audit | Task text, tool results, audit events, conversation | Contract / legitimate interest (security) | 180-day rolling audit; conversation until deleted |
| Device telemetry | Hostname, OS, CPU/memory/disk/load metrics, IP | Contract (service operation) | Latest snapshot + 180 samples (~30 min) |
| Security & abuse prevention | IP, rate-limit counters, timestamps | Legitimate interest (Art. 6(1)(f)) | 24 h (rate limits), 180 days (audit) |

## Data minimisation by design

- **The device stores no provider keys.** Only a remoteagent.online token
  lives locally (`~/.remote-agent/credentials.json`, mode 0600).
- **Telemetry is system metrics only** — no keystrokes, no screen
  content, no file contents. Command results are sent only because you
  asked the agent to run them.
- **Egress-only networking** — the daemon opens no inbound ports and
  sends nothing to third parties.

## Security of processing (Art. 32)

- AES-256-GCM encryption at rest for all key material
- HTTPS/TLS for all traffic
- Per-user bearer tokens + session auth + CSRF protection
- Least-privilege tool sandbox: argv-based allowlisted shell, SSRF-safe
  networking, workspace-confined file tool with TOCTOU guards and
  trash-based deletes
- Local policy is authoritative — the control plane can never widen it
- Full audit trail of every action (cloud) + hash-chained, tamper-evident
  local decision log on each device (`remote-agent audit verify`)

## Data subject rights

- **Access / rectification / erasure** — the dashboard shows your
  agents, conversations and audit entries; delete them there or write to
  `privacy@remoteagent.online`.
- **Portability** — conversations and settings export via API.
- **Objection / restriction** — stop the agent; processing stops
  (device disconnects, no further collection).

## International transfers

- Processing and storage occur in the EU (Hetzner/Hostinger EU data
  centres via the remoteagent.online infrastructure). No data is transferred to
  third countries by remoteagent.online itself.
- AI provider calls (OpenAI, Anthropic, Google, …) are made **with your
  own keys**, under the terms you hold with those providers.

## Sub-processors

| Sub-processor | Purpose |
|---|---|
| Hosting (EU) | Infrastructure for the remoteagent.online cloud |
| AI providers (your keys) | Model inference on your instruction |

## DPIA note

remote-agent processes telemetry and command output, not special-category
data. For typical use a DPIA is not required; a template is available on
request for enterprise deployments (`compliance@remoteagent.online`).

## DPA

A data-processing agreement annex (Art. 28) is available for business
customers on request: `compliance@remoteagent.online`.
