# Run mona-agent as a systemd user service on Linux

## Install

```bash
mkdir -p ~/.config/systemd/user
cp mona-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mona-agent
```

## Useful commands

```bash
systemctl --user status mona-agent   # running? recent log lines
journalctl --user -u mona-agent -f   # follow the log
systemctl --user restart mona-agent  # restart after updates
```

## Uninstall

```bash
systemctl --user disable --now mona-agent
rm ~/.config/systemd/user/mona-agent.service
```

Requires `mona-agent` on your PATH (`~/.local/bin`, set by the installer)
and a systemd user session (standard on desktop distros).
