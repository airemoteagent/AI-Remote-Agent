# Enterprise Deployment Guide

Production rollout for the mona-agent client on macOS, Linux and Windows.

## 1. Provisioning flow

1. Create the user's account and agent in the dashboard.
2. Generate a device token (Settings → Mona key).
3. On the device: install Node.js ≥ 20, then
   `curl -fsSL https://agent.mona.expert/install.sh | bash`
   followed by `mona-agent login` with the token.
4. Start the daemon. Verify the dashboard shows the device online.

## 2. Persistent service (recommended)

**macOS (launchd)** — `~/Library/LaunchAgents/com.mona.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mona.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/agent/apps/desktop/bin/mona-agent.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mona-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/mona-agent.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.mona.agent.plist`.

**Linux (systemd)** — `/etc/systemd/system/mona-agent.service`:

```ini
[Unit]
Description=mona-agent device daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mona
ExecStart=/usr/bin/node /opt/mona-agent/apps/desktop/bin/mona-agent.js start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/mona/.mona-agent
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

Load with `systemctl daemon-reload && systemctl enable --now mona-agent`.

The hardened unit runs the daemon without new privileges, keeps `/`
read-only (only `~/.mona-agent` writable), uses a private `/tmp`, and caps
memory.

## 3. Network policy

- Outbound: TCP 443 to the cloud endpoint only (the daemon).
- The cloud makes the LLM provider calls, not the device.
- No inbound rules. No WebSocket relay required (HTTPS polling fallback).

## 4. Policy & audit rollout

1. Decide the device posture per machine class:
   - unattended/headless: `mona-agent policy preset strict`
   - human-supervised: `mona-agent policy preset standard`
   - least-restricted: `permissive` (default) — not recommended for
     sensitive fleets
2. Review with `mona-agent policy status` and `mona-agent policy explain <tool>`.
3. Verify the audit chain periodically: `mona-agent audit verify`; ship
   `~/.mona-agent/audit.jsonl` to your SIEM/rotation policy. The policy
   file is local and authoritative — the control plane can never widen it.

## 5. Update policy

- Track release tags on GitHub; review the CHANGELOG.
- Rolling update: stop the daemon, update the client directory, start the
  daemon. In-flight tasks expire safely (no replay).
- Run the red-team suite before fleet rollout: `npm test` (includes
  `apps/desktop/test/security.test.mjs`).

## 6. Hardening checklist

- Run the daemon as a dedicated, unprivileged OS user (see hardened
  systemd unit above).
- Apply a policy preset; restrict the shell allowlist if the device
  performs sensitive work.
- Keep the credentials file owner-readable (`chmod 600`); keep the policy
  and audit files owner-readable too.
- Point logs at your log rotation (launchd/systemd examples above).
- Monitor the live event stream for `llm:error` and rate-limit events;
  verify the local audit chain on a schedule.

## 7. Capacity notes

- The daemon is idle-light: polling every 2 s, metrics every 10 s.
- Reasoning cost is per task and visible in the dashboard (Insights tab).
- Auto brain mode balances depth against cost per task automatically.
