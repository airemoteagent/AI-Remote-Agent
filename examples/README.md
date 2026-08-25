# Examples

Copy-paste helpers for running remote-agent in production.

| Directory | Contents |
|---|---|
| [macos/](macos) | LaunchAgent plist — auto-start on login, keep-alive |
| [linux/](linux) | systemd user unit — boot persistence with auto-restart |
| [scripts/](scripts) | `healthcheck.sh` — end-to-end install verification · `disk-watchdog.sh` — cron recipe that alerts before a volume fills · `morning-briefing.sh` — the 8am briefing recipe |
| [providers/](providers) | BYO-key brain templates — Anthropic, OpenAI-compatible, Ollama (offline) |

More recipes: [../docs/EXAMPLES.md](../docs/EXAMPLES.md)
