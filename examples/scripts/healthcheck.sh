#!/usr/bin/env bash
# healthcheck.sh — verify a mona-agent installation end to end.
# Usage: bash healthcheck.sh   (exit 0 = ok, 1 = problem found)
set -u

RED='\033[31m'; GREEN='\033[32m'; RESET='\033[0m'
fail=0

say()  { printf '%s\n' "$*"; }
ok()   { printf "  ${GREEN}ok${RESET}  %s\n" "$*"; }
bad()  { printf "  ${RED}bad${RESET} %s\n" "$*"; fail=1; }

say "mona-agent health check"

# 1. Binary on PATH
if command -v mona-agent >/dev/null 2>&1; then
  ok "mona-agent on PATH ($(command -v mona-agent))"
else
  bad "mona-agent not on PATH — run the installer: curl -fsSL https://agent.mona.expert/install.sh | bash"
  exit 1
fi

# 2. Node.js version
if node -v 2>/dev/null | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
  ok "Node.js $(node -v)"
else
  bad "Node.js 20+ required (found: $(node -v 2>/dev/null || echo none))"
fi

# 3. Credentials present
if [ -f "$HOME/.mona-agent/credentials.json" ]; then
  ok "credentials.json present"
else
  bad "not logged in — run: mona-agent login"
fi

# 4. Process running
if pgrep -f "mona-agent.*(start|gui)" >/dev/null 2>&1; then
  ok "daemon process running (pid $(pgrep -f "mona-agent.*(start|gui)" | head -1))"
else
  bad "daemon not running — start with: mona-agent start"
fi

# 5. Cloud connectivity + key validity
if mona-agent connect >/tmp/mona-health.$$.log 2>&1; then
  ok "cloud connection ok (health, auth, agents)"
else
  bad "cloud connection failed:"
  sed 's/^/      /' /tmp/mona-health.$$.log | tail -8
fi
rm -f /tmp/mona-health.$$.log

say ""
if [ "$fail" -eq 0 ]; then
  say "${GREEN}All checks passed.${RESET}"
else
  say "${RED}Some checks failed — see above.${RESET}"
fi
exit "$fail"
