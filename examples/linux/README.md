# Run remote-agent as a systemd user service on Linux

## Install

```bash
mkdir -p ~/.config/systemd/user
cp remote-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now remote-agent
```

## Useful commands

```bash
systemctl --user status remote-agent   # running? recent log lines
journalctl --user -u remote-agent -f   # follow the log
systemctl --user restart remote-agent  # restart after updates
```

## Uninstall

```bash
systemctl --user disable --now remote-agent
rm ~/.config/systemd/user/remote-agent.service
```

Requires `remote-agent` on your PATH (`~/.local/bin`, set by the installer)
and a systemd user session (standard on desktop distros).
