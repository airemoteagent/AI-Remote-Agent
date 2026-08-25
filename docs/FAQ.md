# Frequently Asked Questions

## What is mona-agent?

An open-source AI agent that runs on your own machine — macOS, Linux and WSL2. It connects your
machine to the mona.expert cloud, executes local tools on your behalf, and
streams live metrics to your dashboard.

## Is mona-agent free?

Yes — MIT licensed, free forever. The [mona.expert](https://agent.mona.expert)
cloud has a free tier.

## Does mona-agent need an API key?

It needs **one key**: your mona.expert device token (created in the
dashboard  Settings). AI provider keys (OpenAI, Anthropic, …) live only in
the cloud vault — never on your device. Since v2.10.1 you can instead
bring your own keys on-device:

```bash
mona-agent provider set anthropic     # or: openai / ollama
MONA_TRANSPORT=local mona-agent start
```

Then prompts never leave the machine at all. See
[examples/providers](../examples/providers/README.md).

## Can it run fully offline?

Yes — with a local provider. `mona-agent provider set ollama` +
`MONA_TRANSPORT=local` runs the brain on Ollama at
`http://127.0.0.1:11434`: no API key, $0 tokens, no prompt leaves the
device. Anthropic and any OpenAI-compatible endpoint (LM Studio, vLLM,
OpenRouter) work the same way.

## Where is my key stored?

`~/.mona-agent/credentials.json`, with restrictive permissions, outside the
install directory (which can be wiped and reinstalled safely).

## What does mona-agent send to the cloud?

Only to the cloud you are logged into:

- device metrics (CPU, memory, disk, load, uptime, host info)
- results of commands/tools the cloud agent asked for
- chat messages you send from the dashboard

Nothing is sent to third parties. Full details: [SECURITY.md](../SECURITY.md).

## Does the device need a public IP or open ports?

No. The agent opens **outbound** connections only. It works behind NAT,
firewalls and CGNAT. It listens on localhost only (for the local dashboard).

## Can I run mona-agent on a server / Raspberry Pi?

Yes — any Node.js 20+ machine. Headless mode: `mona-agent start` (or a
systemd unit). Small footprint, one runtime dependency.

## Does it work on Windows?

In WSL2 or Git Bash, yes. Native PowerShell is not a target today.

## How do I update mona-agent?

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
```

The installer replaces the agent in place; your credentials are untouched.

## How do I uninstall?

```bash
rm -rf ~/.mona-agent ~/.local/bin/mona-agent
```

## Why does my dashboard show my device as offline?

The device is marked online when its last metrics snapshot is ≤ 20 seconds
old. Check `mona-agent start` is running and that the device has HTTPS
egress to agent.mona.expert.

## Can the agent damage my machine?

The sandbox is layered: the shell executes argv arrays (no shell strings)
with a realpath-resolved allowlist, the files tool is confined to a
workspace (traversal, symlink and TOCTOU escapes rejected; deletes go to
trash), and the network tool is SSRF-safe (private ranges and cloud
metadata unreachable). A local policy file (`~/.mona-agent/policy.json`)
can deny or gate any tool, and every decision lands in a hash-chained
local audit log (`mona-agent audit verify`). Start with
`mona-agent policy preset strict` for a read-only agent. Treat the agent
like any other user with shell access: grant what you trust.

## How do I tighten or loosen the agent?

```bash
mona-agent policy preset strict      # read-only (no shell/net/browser)
mona-agent policy preset standard    # shell & browser need approval
mona-agent policy preset permissive  # everything allowed (default)
mona-agent policy explain <tool> …   # why a call is allowed/denied
mona-agent audit verify              # confirm the audit chain is intact
```

Edit `~/.mona-agent/policy.json` directly for rate limits, budget caps
and extra shell patterns — see [TOOLS.md](TOOLS.md).

## Where do I report bugs or security issues?

Bugs: [GitHub issues](https://github.com/MONAEXPERT/agent/issues).
Security: [SECURITY.md](../SECURITY.md) (private disclosure first).
