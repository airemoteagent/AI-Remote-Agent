# Data Flow & Data Minimization

This document describes where data lives and moves in a mona-agent
deployment, for GDPR/DPIA reviews and security assessments.

## Data inventory

| Data | Created at | Stored at | Retention |
|---|---|---|---|
| User account | Cloud (Sngine) | Cloud DB | Until account deletion |
| Device token | Cloud, on request | Cloud DB (plain, revocable) + device config | Until revoked |
| Provider API keys | User input (dashboard) | Cloud DB, AES-256-GCM encrypted | Until deleted |
| Chat messages | Dashboard / device | Cloud DB | Per-user; delete per agent or factory reset |
| Run traces (reasoning, tool calls, results) | Device loop | Cloud DB (runs + steps) | Deleted with agent / factory reset |
| Usage & cost metrics | Every LLM call | Cloud DB | Aggregated for insights; per-run detail deleted with agent |
| Device telemetry (CPU/mem/disk/uptime) | Device, every 10 s | Cloud DB (latest + rolling history) | Forgotten on "Forget device" |
| Device files & command output | Device tools | **Stays on the device** except task-relevant results streamed to the cloud for the brain | Ephemeral per run |
| Policy file | User (device) | `~/.mona-agent/policy.json` — local, authoritative, never sent to the cloud | Until edited |
| Local audit log | Device policy engine | `~/.mona-agent/audit.jsonl` — hash-chained, append-only, 0600; never leaves the device | Until deleted by the user |
| Trash | Device file tool | `~/.mona-agent/trash` — recoverable deletes | Until purged |

## Data flow (one task)

1. User sends a message (dashboard → cloud over TLS).
2. Cloud queues the task; the device polls and claims it (outbound HTTPS).
3. Device sends context to the cloud brain; the cloud calls the LLM provider
   using the user's key (decrypted in memory only).
4. Brain decides tool calls; the device executes them locally and returns
   results to the cloud.
5. The cloud stores the conversation, the run trace and usage metrics; the
   dashboard streams the answer to the user.

## Minimization principles

- **No secrets on devices.** Provider keys never leave the cloud; child
  processes get a scrubbed environment (only `PATH/HOME/LANG` + safe vars).
- **No model weights anywhere in this product.** The product is a control
  plane; the models are third-party APIs.
- **Telemetry is performance-only** (CPU, memory, disk, uptime, load). No
  keystrokes, no screen capture, no browsing history.
- **Tool output is truncated** for transport (bounded context) — the full
  output stays on the device unless the task requires it.
- **Deletes are recoverable by default** — the file tool moves files to a
  local trash directory; permanent deletion requires an explicit `purge`.
- **Local decisions stay local** — the policy file and the hash-chained
  audit log never leave the device; the cloud sees only what the task needs.

## Data subject rights (operator toolkit)

- **Export**: per-user training export (JSONL) and audit log access.
- **Delete**: per-agent deletion, per-user factory reset, device
  telemetry forget, token revocation — all available in the dashboard.
- **Minimize**: free plan limits bound data volume per account.
