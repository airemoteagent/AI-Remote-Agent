# Frequently Asked Questions

## What is remote-agent?

An open-source AI agent that runs on your own machine — macOS, Linux and WSL2. It connects your
machine to the remoteagent.online cloud, executes local tools on your behalf, and
streams live metrics to your dashboard.

## Is remote-agent free?

Yes — MIT licensed, free forever. The [remoteagent.online](https://remoteagent.online)
cloud has a free tier.

## Does remote-agent need an API key?

It needs **one key**: your remoteagent.online device token (created in the
dashboard  Settings). AI provider keys (OpenAI, Anthropic, …) live only in
the cloud vault — never on your device. Since v2.10.1 you can instead
bring your own keys on-device:

```bash
remote-agent provider set anthropic     # or: openai / ollama
REMOTE_TRANSPORT=local remote-agent start
```

Then prompts never leave the machine at all. See
[examples/providers](../examples/providers/README.md).

## Can it run fully offline?

Yes — with a local provider. `remote-agent provider set ollama` +
`REMOTE_TRANSPORT=local` runs the brain on Ollama at
`http://127.0.0.1:11434`: no API key, $0 tokens, no prompt leaves the
device. Anthropic and any OpenAI-compatible endpoint (LM Studio, vLLM,
OpenRouter) work the same way.

## Where is my key stored?

`~/.remote-agent/credentials.json`, with restrictive permissions, outside the
install directory (which can be wiped and reinstalled safely).

## What does remote-agent send to the cloud?

Only to the cloud you are logged into:

- device metrics (CPU, memory, disk, load, uptime, host info)
- results of commands/tools the cloud agent asked for
- chat messages you send from the dashboard

Nothing is sent to third parties. Full details: [SECURITY.md](../SECURITY.md).

## Does the device need a public IP or open ports?

No. The agent opens **outbound** connections only. It works behind NAT,
firewalls and CGNAT. It listens on localhost only (for the local dashboard).

## Can I run remote-agent on a server / Raspberry Pi?

Yes — any Node.js 20+ machine. Headless mode: `remote-agent start` (or a
systemd unit). Small footprint, one runtime dependency.

## Does it work on Windows?

In WSL2 or Git Bash, yes. Native PowerShell is not a target today.

## How do I update remote-agent?

```bash
curl -fsSL https://remoteagent.online/install.sh | bash
```

The installer replaces the agent in place; your credentials are untouched.

## How do I uninstall?

```bash
rm -rf ~/.remote-agent ~/.local/bin/remote-agent
```

## Why does my dashboard show my device as offline?

The device is marked online when its last metrics snapshot is ≤ 20 seconds
old. Check `remote-agent start` is running and that the device has HTTPS
egress to remoteagent.online.

## Can the agent damage my machine?

The sandbox is layered: the shell executes argv arrays (no shell strings)
with a realpath-resolved allowlist, the files tool is confined to a
workspace (traversal, symlink and TOCTOU escapes rejected; deletes go to
trash), and the network tool is SSRF-safe (private ranges and cloud
metadata unreachable). A local policy file (`~/.remote-agent/policy.json`)
can deny or gate any tool, and every decision lands in a hash-chained
local audit log (`remote-agent audit verify`). Start with
`remote-agent policy preset strict` for a read-only agent. Treat the agent
like any other user with shell access: grant what you trust.

## How do I tighten or loosen the agent?

```bash
remote-agent policy preset strict      # read-only (no shell/net/browser)
remote-agent policy preset standard    # shell & browser need approval
remote-agent policy preset permissive  # everything allowed (default)
remote-agent policy explain <tool> …   # why a call is allowed/denied
remote-agent audit verify              # confirm the audit chain is intact
```

Edit `~/.remote-agent/policy.json` directly for rate limits, budget caps
and extra shell patterns — see [TOOLS.md](TOOLS.md).

## Where do I report bugs or security issues?

Bugs: [GitHub issues](https://github.com/remoteagent-online/remote-agent/issues).
Security: [SECURITY.md](../SECURITY.md) (private disclosure first).
