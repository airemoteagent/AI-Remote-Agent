# Run remote-agent automatically on macOS

Install this LaunchAgent to start remote-agent when you log in and keep it
running (auto-restart on crash).

## Install

```bash
mkdir -p ~/Library/LaunchAgents
cp com.remoteagent.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.remoteagent.agent.plist
```

## Verify

```bash
launchctl list | grep remoteagent
remote-agent connect    # should report cloud reachable, key valid
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.remoteagent.agent.plist
rm ~/Library/LaunchAgents/com.remoteagent.agent.plist
```

Requires `remote-agent` on your PATH (`~/.local/bin`, set by the installer).
