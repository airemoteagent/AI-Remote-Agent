#!/usr/bin/env bash
# disk-watchdog.sh — alert before a volume fills up.
#
# A remote-agent recipe: run this from cron (or the dashboard's cron tasks)
# so the agent checks disk health and notifies you before things break.
#
#   crontab -e
#   # every morning at 8:00
#   0 8 * * * /path/to/remote-agent/examples/scripts/disk-watchdog.sh
#
# The agent runs the disk-health skill (read-only, safe by default) and
# flags volumes above 85% with a concrete cleanup suggestion. It proposes,
# never deletes — you stay in control.
set -euo pipefail

THRESHOLD="${REMOTE_WATCHDOG_THRESHOLD:-85}"

if ! command -v remote-agent >/dev/null 2>&1; then
  echo "disk-watchdog: remote-agent not found on PATH" >&2
  exit 1
fi

# One-shot chat through the connected agent. The disk-health skill steers
# the brain to df-check every volume and explain anything at risk.
remote-agent chat "Run the disk-health skill: check all volumes. Flag every volume above ${THRESHOLD}% with what it is, how much is free, and one safe cleanup suggestion (propose only, never delete)."
