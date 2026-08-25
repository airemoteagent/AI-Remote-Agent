# Getting Started with remote-agent

Install the remote-agent app on your device, log in with your remoteagent.online key, and
have your machine connected to the cloud in under a minute.

## 1. Prerequisites

- **Node.js 20 or newer** — check with `node -v`.
  - macOS: `brew install node`
  - Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install nodejs`
  - Windows: use [WSL2](https://learn.microsoft.com/windows/wsl/install) (native Windows Git Bash works too)
- An account + **API key** at [remoteagent.online](https://remoteagent.online/dashboard)  Settings.

## 2. Install

```bash
curl -fsSL https://remoteagent.online/install.sh | bash
```

The installer:

- Downloads the agent from GitHub (`remoteagent-online/remote-agent`)
- Installs dependencies (`ws` only)
- Places the app in `~/.remote-agent/agent`
- Adds `remote-agent` to your PATH (via `~/.local/bin`, persisted in your shell rc)

## 3. Log in

```bash
remote-agent login
```

Paste your remoteagent.online API key when prompted. The key is stored in
`~/.remote-agent/credentials.json` (outside the agent install directory).

## 4. Connect and use

```bash
remote-agent gui                    # terminal dashboard with live log
remote-agent chat "free disk space" # one-shot conversation
remote-agent exec shell cmd=uptime  # run a single allowed command
remote-agent start                  # headless background service (auto-reconnect)
```

### Capability dial: from zero skills to full daemon

Pick how much power the agent gets on this device:

```bash
remote-agent mode list              # minimal · standard · full
remote-agent mode show              # current mode + effective policy
remote-agent mode set minimal       # read-only: no skills, no shell, no network writes
remote-agent mode set standard      # balanced: core skills, shell/browser need approval
remote-agent mode set full          # everything on + auto-start daemon
```

Setting a mode writes `~/.remote-agent/policy.json` (the device-side authority),
enables/disables the matching skills and — in `full` — installs the background
service so the agent starts on login and restarts on crash (launchd on macOS,
systemd on Linux):

```bash
remote-agent daemon status          # service + pid state
remote-agent daemon install         # enable auto-start on login
remote-agent daemon uninstall       # stop + remove the service
remote-agent skills list            # installed skills + enabled state
```

Only one daemon can run per device: `remote-agent start` refuses to double-run
(see `~/.remote-agent/daemon.pid`), and `start --force` is only for crash recovery.

## 5. Security defaults (v2.8+)

- **Shell** — commands are parsed into argv arrays and executed without a
  shell; every executable must be on the allowlist (realpath-checked).
  Chains (`&&`, `;`, pipes) re-check every segment; `sudo`, redirects,
  `$(...)` and backticks are rejected. To run other commands, extend
  `REMOTE_ALLOW_CMDS` (comma-separated) or set `{"shell": {"unsafe": true}}`
  in `~/.remote-agent/policy.json` (audited).
- **Network** — SSRF-safe: private ranges, loopback and cloud metadata are
  unreachable, redirects are re-validated per hop.
- **Files** — confined to the workspace; deletes move to trash.
- **Policy** — every tool call is checked against `~/.remote-agent/policy.json`
  (allow / deny / confirm / rate limits). The control plane can never widen
  it. Apply a preset:

```bash
remote-agent policy preset strict      # read-only agent
remote-agent policy preset standard    # shell/browser need approval
remote-agent policy status             # what's currently allowed
remote-agent policy explain shell cmd=df  # why a call is allowed/denied
```

- **Audit** — every decision is written to a tamper-evident, hash-chained
  log. Verify it anytime:

```bash
remote-agent audit tail                # recent decisions
remote-agent audit verify              # detect tampering
```

## 6. See it in the browser

Open <https://remoteagent.online/dashboard>. Your device appears with live
CPU, memory, disk and load — and a chat window connected to the cloud brain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `remote-agent: command not found` | Re-open your terminal, or run `export PATH="$HOME/.local/bin:$PATH"` |
| `Node.js 20+ required` | Upgrade Node (`brew upgrade node` / nodesource) |
| Agent connects but dashboard shows no device | Confirm you ran `remote-agent login` with the key from your account |
| Metrics stream, chat replies "No API key configured" | Add an AI provider key in the dashboard  Settings (the cloud brain needs one) |
| Firewall / corporate proxy | Set `REMOTE_CLOUD=https://remoteagent.online` and check HTTPS egress |

## Bring your own LLM (BYO keys)

Since v2.10.1 the brain can run on-device with **your** keys instead of
the cloud vault — prompts never leave the machine.

```bash
remote-agent provider set anthropic                          # asks for the key
remote-agent provider set openai --model gpt-4o-mini
remote-agent provider set openai --url http://localhost:1234/v1 --model llama-3   # LM Studio / vLLM
remote-agent provider set ollama --model llama3.2            # fully offline, $0
remote-agent provider test                                   # one-shot smoke test
REMOTE_TRANSPORT=local remote-agent start                      # local brain only, fail-fast
```

Config lives in `~/.remote-agent/provider.json` (0600, never sent to the
cloud). BYO tokens are priced locally so the budget governor and cost
traces keep working — see `remote-agent provider status`. Templates:
[examples/providers](../examples/providers/README.md).

## MCP — expose the tools to other agents

`remote-agent mcp` serves the tool registry to any Model Context Protocol
client over stdio. Every call passes the local policy gate.

## Uninstall

```bash
rm -rf ~/.remote-agent ~/.local/bin/remote-agent
# optional: remove the PATH line added to ~/.zshrc / ~/.bashrc / ~/.profile
```

## Next steps

- [TOOLS.md](TOOLS.md) — what the agent can do on your device
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the agent works under the hood
- [FAQ.md](FAQ.md) — common questions
- [SECURITY.md](../SECURITY.md) — security model & responsible disclosure
