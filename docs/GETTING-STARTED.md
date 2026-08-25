# Getting Started with mona-agent

Install the mona-agent app on your device, log in with your mona.expert key, and
have your machine connected to the cloud in under a minute.

## 1. Prerequisites

- **Node.js 20 or newer** — check with `node -v`.
  - macOS: `brew install node`
  - Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install nodejs`
  - Windows: use [WSL2](https://learn.microsoft.com/windows/wsl/install) (native Windows Git Bash works too)
- An account + **API key** at [agent.mona.expert](https://agent.mona.expert/dashboard)  Settings.

## 2. Install

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
```

The installer:

- Downloads the agent from GitHub (`MONAEXPERT/agent`)
- Installs dependencies (`ws` only)
- Places the app in `~/.mona-agent/agent`
- Adds `mona-agent` to your PATH (via `~/.local/bin`, persisted in your shell rc)

## 3. Log in

```bash
mona-agent login
```

Paste your mona.expert API key when prompted. The key is stored in
`~/.mona-agent/credentials.json` (outside the agent install directory).

## 4. Connect and use

```bash
mona-agent gui                    # terminal dashboard with live log
mona-agent chat "free disk space" # one-shot conversation
mona-agent exec shell cmd=uptime  # run a single allowed command
mona-agent start                  # headless background service (auto-reconnect)
```

### Capability dial: from zero skills to full daemon

Pick how much power the agent gets on this device:

```bash
mona-agent mode list              # minimal · standard · full
mona-agent mode show              # current mode + effective policy
mona-agent mode set minimal       # read-only: no skills, no shell, no network writes
mona-agent mode set standard      # balanced: core skills, shell/browser need approval
mona-agent mode set full          # everything on + auto-start daemon
```

Setting a mode writes `~/.mona-agent/policy.json` (the device-side authority),
enables/disables the matching skills and — in `full` — installs the background
service so the agent starts on login and restarts on crash (launchd on macOS,
systemd on Linux):

```bash
mona-agent daemon status          # service + pid state
mona-agent daemon install         # enable auto-start on login
mona-agent daemon uninstall       # stop + remove the service
mona-agent skills list            # installed skills + enabled state
```

Only one daemon can run per device: `mona-agent start` refuses to double-run
(see `~/.mona-agent/daemon.pid`), and `start --force` is only for crash recovery.

## 5. Security defaults (v2.8+)

- **Shell** — commands are parsed into argv arrays and executed without a
  shell; every executable must be on the allowlist (realpath-checked).
  Chains (`&&`, `;`, pipes) re-check every segment; `sudo`, redirects,
  `$(...)` and backticks are rejected. To run other commands, extend
  `MONA_ALLOW_CMDS` (comma-separated) or set `{"shell": {"unsafe": true}}`
  in `~/.mona-agent/policy.json` (audited).
- **Network** — SSRF-safe: private ranges, loopback and cloud metadata are
  unreachable, redirects are re-validated per hop.
- **Files** — confined to the workspace; deletes move to trash.
- **Policy** — every tool call is checked against `~/.mona-agent/policy.json`
  (allow / deny / confirm / rate limits). The control plane can never widen
  it. Apply a preset:

```bash
mona-agent policy preset strict      # read-only agent
mona-agent policy preset standard    # shell/browser need approval
mona-agent policy status             # what's currently allowed
mona-agent policy explain shell cmd=df  # why a call is allowed/denied
```

- **Audit** — every decision is written to a tamper-evident, hash-chained
  log. Verify it anytime:

```bash
mona-agent audit tail                # recent decisions
mona-agent audit verify              # detect tampering
```

## 6. See it in the browser

Open <https://agent.mona.expert/dashboard>. Your device appears with live
CPU, memory, disk and load — and a chat window connected to the cloud brain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `mona-agent: command not found` | Re-open your terminal, or run `export PATH="$HOME/.local/bin:$PATH"` |
| `Node.js 20+ required` | Upgrade Node (`brew upgrade node` / nodesource) |
| Agent connects but dashboard shows no device | Confirm you ran `mona-agent login` with the key from your account |
| Metrics stream, chat replies "No API key configured" | Add an AI provider key in the dashboard  Settings (the cloud brain needs one) |
| Firewall / corporate proxy | Set `MONA_CLOUD=https://agent.mona.expert` and check HTTPS egress |

## Bring your own LLM (BYO keys)

Since v2.10.1 the brain can run on-device with **your** keys instead of
the cloud vault — prompts never leave the machine.

```bash
mona-agent provider set anthropic                          # asks for the key
mona-agent provider set openai --model gpt-4o-mini
mona-agent provider set openai --url http://localhost:1234/v1 --model llama-3   # LM Studio / vLLM
mona-agent provider set ollama --model llama3.2            # fully offline, $0
mona-agent provider test                                   # one-shot smoke test
MONA_TRANSPORT=local mona-agent start                      # local brain only, fail-fast
```

Config lives in `~/.mona-agent/provider.json` (0600, never sent to the
cloud). BYO tokens are priced locally so the budget governor and cost
traces keep working — see `mona-agent provider status`. Templates:
[examples/providers](../examples/providers/README.md).

## MCP — expose the tools to other agents

`mona-agent mcp` serves the tool registry to any Model Context Protocol
client over stdio. Every call passes the local policy gate.

## Uninstall

```bash
rm -rf ~/.mona-agent ~/.local/bin/mona-agent
# optional: remove the PATH line added to ~/.zshrc / ~/.bashrc / ~/.profile
```

## Next steps

- [TOOLS.md](TOOLS.md) — what the agent can do on your device
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the agent works under the hood
- [FAQ.md](FAQ.md) — common questions
- [SECURITY.md](../SECURITY.md) — security model & responsible disclosure
