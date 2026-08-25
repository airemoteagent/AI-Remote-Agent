#!/usr/bin/env bash
# morning-briefing.sh — the 8am briefing recipe.
#
# Schedule with cron (or the dashboard's cron tasks):
#   0 8 * * * /path/to/remote-agent/examples/scripts/morning-briefing.sh
#
# The briefing skill gathers headlines and system health, then the agent
# summarizes them. Read-only: no writes, no deletes.
set -euo pipefail

if ! command -v remote-agent >/dev/null 2>&1; then
  echo "morning-briefing: remote-agent not found on PATH" >&2
  exit 1
fi

remote-agent chat "Run the briefing skill: today's headlines, this machine's health (disk-health skill), and a one-line plan for the day."
