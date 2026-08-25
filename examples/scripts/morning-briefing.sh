#!/usr/bin/env bash
# morning-briefing.sh — the 8am briefing recipe.
#
# Schedule with cron (or the dashboard's cron tasks):
#   0 8 * * * /path/to/mona-agent/examples/scripts/morning-briefing.sh
#
# The briefing skill gathers headlines and system health, then the agent
# summarizes them. Read-only: no writes, no deletes.
set -euo pipefail

if ! command -v mona-agent >/dev/null 2>&1; then
  echo "morning-briefing: mona-agent not found on PATH" >&2
  exit 1
fi

mona-agent chat "Run the briefing skill: today's headlines, this machine's health (disk-health skill), and a one-line plan for the day."
