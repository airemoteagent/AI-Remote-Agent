# Examples & Recipes

Real things people do with remote-agent. Copy, adapt, enjoy.

## Teach the agent your environment (vector memory)

Index a folder of notes/configs in the workspace once, then ask questions in
plain language — the agent retrieves the closest chunks by meaning:

```bash
remote-agent exec vector action=index path="."
remote-agent exec vector action=remember text="deploy server ssh is on port 65002"
remote-agent exec vector action=search query="how do I restart the web server"
```

Every new task automatically receives the closest vector hits as context, so
"restart nginx" works even when the notes say "brew services restart nginx".

## Check on your machine from your phone

1. `remote-agent start` on the machine (or install the launchd/systemd unit
   from [examples/](../examples)).
2. Open <https://remoteagent.online/dashboard> on your phone.
3. Chat: *"How's the disk looking?"* — the agent reads `df -h`, and the
   dashboard shows live CPU/memory sparklines.

## Morning briefing with cron

Get a daily summary of your home server in your dashboard before coffee:

```cron
# ~/.config/cron.d/remote-agent (or: crontab -e)
30 7 * * *  $HOME/.local/bin/remote-agent chat "Summarize disk usage, uptime and any failed systemd units."
```

The reply lands in the dashboard chat history, timestamped.

## Watchdog — alert when a service dies

Ask the agent every 10 minutes; it pings the service and only reports
problems (the cloud keeps the conversation context):

```cron
*/10 * * * *  $HOME/.local/bin/remote-agent chat "Check nginx is answering on :80. Only reply if something is wrong."
```

## Nightly log cleanup

```cron
10 3 * * *  $HOME/.local/bin/remote-agent exec shell cmd="ls -la ~/logs | tail -20"
```

`exec` runs one tool with `key=value` arguments — the command still passes
through the shell allowlist and policy. To let the agent run your own
scripts, extend the allowlist or set `{"shell": {"unsafe": true}}` in
`~/.remote-agent/policy.json` (audited, tamper-evident).

## Health check from any shell

```bash
remote-agent connect          # force a connection test: health, auth, agents
```

`connect` reports cloud reachability, key validity and the agent list —
ideal for install verification and support tickets.

## Drive a script from the dashboard

Anything you put in an allowlisted command, the agent can run it for you.
To run arbitrary scripts, grant them explicitly:

```bash
# 1. Let the agent run your own commands (comma-separated)
export REMOTE_ALLOW_CMDS="df,uptime,uname,whoami,date,hostname,free,ps,top,cat,head,tail,wc,ls,pwd,echo,env,which,backup.sh"

# 2. backup.sh — called from the dashboard chat
#!/usr/bin/env bash
tar czf - ~/projects | gpg -c --batch --passphrase-file ~/.backup-pass -o /mnt/backup/projects.tgz.gpg
```

Say *"run backup.sh"* in the chat; the guarded shell executes it and
streams the result back to your browser. Every run lands in the audit log.

## Lock it down (security recipes)

```bash
remote-agent policy preset strict      # read-only agent: no shell, no network
remote-agent policy explain shell      # see exactly which rule governs shell
remote-agent audit tail                # last 20 policy decisions
remote-agent audit verify              # prove the audit chain is untampered
```

Ideal for unattended machines and compliance reviews: the policy file is
local and authoritative — the control plane can never widen it.

## Headless Raspberry Pi companion

The agent runs on any Node.js 20+ box:

```bash
curl -fsSL https://remoteagent.online/install.sh | bash
remote-agent login
remote-agent start          # survives reboots via the systemd unit in examples/
```

Then manage the Pi from the dashboard: temperature, storage, running
services — with live metrics and chat.

## More

- [INTEGRATIONS.md](INTEGRATIONS.md) — the cloud REST API and scheduling
- [TOOLS.md](TOOLS.md) — the built-in tool sandbox
- [examples/](../examples) — launchd & systemd units, health check script
