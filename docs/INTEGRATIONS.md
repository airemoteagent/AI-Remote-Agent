# Integrations

mona-agent is designed to be glued into whatever you already run.

## Cloud REST API (client view)

The daemon talks to the control plane at `https://agent.mona.expert` over
HTTPS with Bearer auth. From a client perspective the endpoints are:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/agent/health` | Cloud health / uptime check |
| GET | `/api/v1/agent/verify` | Validate the device token |
| POST | `/api/v1/agent/chat/:agentId` | Send a chat message, get a reply |
| POST | `/api/v1/agent/tool/:agentId` | Execute a tool directly |
| GET | `/api/v1/agent/agents` | List your agents |
| POST | `/api/v1/agent/think` | Streaming reasoning (SSE) |
| POST | `/api/v1/agent/stats` | Device metrics snapshot (every 10 s) |

The client picks the right base URL and paths automatically
(`MONA_CLOUD` overrides the default).

## Boot persistence

Keep the daemon alive across reboots:

- **macOS** — install [examples/macos/com.monaexpert.agent.plist](../examples/macos/com.monaexpert.agent.plist)
  into `~/Library/LaunchAgents/` and `launchctl load` it.
- **Linux (systemd)** — drop [examples/linux/mona-agent.service](../examples/linux/mona-agent.service)
  into `~/.config/systemd/user/` and `systemctl --user enable --now mona-agent`.
- **cron fallback** — `@reboot $HOME/.local/bin/mona-agent start`

## Scheduling

The agent plays nicely with cron (see [EXAMPLES.md](EXAMPLES.md) for
recipes). One-liners:

```bash
mona-agent chat "…"   # ask the cloud brain, answer in dashboard history
mona-agent exec shell cmd="df -h"   # run an allowlisted command, stream output
mona-agent policy preset standard    # require approval for shell/browser
mona-agent audit verify              # verify the tamper-evident audit chain
```

## Health checks

- **Interactive** — `mona-agent connect` runs the full connectivity test
  (health, auth, agent list) and prints the result.
- **Scripted** — parse `mona-agent connect` exit code in your monitoring:

```bash
if mona-agent connect; then echo "agent ok"; else echo "agent degraded"; fi
```

## Webhooks & outbound calls

The `net` tool lets the agent call your webhooks, health endpoints or
notification services (outbound HTTPS only):

```bash
mona-agent exec "curl -fsS https://hc-ping.com/<your-uuid>"
```

## Building on the client

- `packages/engine` — the cloud-brain client (self-contained)
- `packages/protocol` — typed message schemas shared with the cloud

Both are MIT licensed; reuse them freely.
