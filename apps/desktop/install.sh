#!/usr/bin/env bash
# ── mona-agent installer ──────────────────────────────────────────
# Usage: curl -fsSL https://agent.mona.expert/install.sh | bash
#
# Installs the agent to ~/.mona-agent/agent and puts a `mona-agent`
# command on your PATH (~/.local/bin). PATH is set for the current
# shell AND persisted in ~/.zshrc / ~/.bashrc / ~/.profile, so the
# command also works in every new terminal.
#
# Options:
#   --version <tag>   install a specific release tag (default: main)
#   --dry-run         print what would happen, change nothing
#   --allow-root      permit running as root (refused by default)
#
# Supply-chain: when installing a release tag, the tarball is verified
# against the SHA256SUMS asset on the GitHub release. If the manifest
# is missing the installer warns; set MONA_REQUIRE_CHECKSUM=1 to fail
# hard. The extracted version is checked against the requested tag.
set -euo pipefail

REPO="${MONA_REPO:-MONAEXPERT/agent}"
BRANCH="${MONA_BRANCH:-main}"
INSTALL_DIR="${MONA_INSTALL_DIR:-$HOME/.mona-agent}"
VERSION_REQ=""
DRY_RUN=0
ALLOW_ROOT=0
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION_REQ="${2:-}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    *) echo -e "  ${RED}Unknown option: $1${RESET}" >&2; exit 2 ;;
  esac
done

REF="$BRANCH"
URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
CHECKSUM_URL=""
TARBALL_NAME=""
if [ -n "$VERSION_REQ" ]; then
  REF="$VERSION_REQ"
  # Release tags install the exact asset covered by SHA256SUMS, never
  # GitHub's separately generated source archive.
  TARBALL_NAME="mona-agent-$VERSION_REQ.tar.gz"
  URL="https://github.com/$REPO/releases/download/$VERSION_REQ/$TARBALL_NAME"
  CHECKSUM_URL="https://github.com/$REPO/releases/download/$VERSION_REQ/SHA256SUMS"
fi

echo ""
echo -e "  ${BOLD}${CYAN} mona-agent${RESET} installer"
[ "$DRY_RUN" = 1 ] && echo -e "  ${YELLOW} DRY RUN — nothing will be changed${RESET}"
echo -e "  ───────────────────────"
echo ""

# ── Platform ────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)                  PLATFORM="macOS" ;;
  Linux)                   PLATFORM="Linux" ;;
  MINGW*|MSYS*|CYGWIN*)    PLATFORM="Windows (Git Bash)" ;;
  *)                       PLATFORM="$OS" ;;
esac
echo -e "  Platform: ${BOLD}$PLATFORM${RESET} ($ARCH)"

# ── Refuse root ──────────────────────────────────────────────────
if [ "$(id -u)" = 0 ] && [ "$ALLOW_ROOT" = 0 ]; then
  echo -e "  ${RED}Refusing to run as root.${RESET} Install as your user, or re-run with --allow-root."
  exit 1
fi

# ── Prerequisites ───────────────────────────────────────────────
if [ "$DRY_RUN" = 1 ]; then
  echo -e "  ${DIM}Would check Node.js 20+ (found $(node -v 2>/dev/null || echo none))${RESET}"
else
  command -v node >/dev/null 2>&1 || {
    echo -e "  ${RED}Node.js 20+ required — install from https://nodejs.org${RESET}"
    exit 1
  }
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo -e "  ${RED}Node.js 20+ required (found $(node -v))${RESET}"
    exit 1
  fi
  echo -e "  ${GREEN}Node.js $(node -v)  |  npm $(npm -v)${RESET}"
fi

# ── Download ────────────────────────────────────────────────────
echo -e "  ${DIM}Downloading ${REPO}@${REF} from GitHub${RESET}"
if [ "$DRY_RUN" = 1 ]; then
  echo -e "  ${DIM}Would download: ${URL}${RESET}"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$URL" -o "$TMP_DIR/archive.tar.gz"
TARBALL_ACTUAL="$TMP_DIR/archive.tar.gz"

# ── Checksum verification (release installs) ────────────────────
if [ -n "$VERSION_REQ" ]; then
  if [ "${MONA_REQUIRE_CHECKSUM:-1}" != 1 ]; then
    echo -e "  ${RED}Refusing insecure release install: MONA_REQUIRE_CHECKSUM must remain 1${RESET}"
    exit 1
  fi
  if curl -fsSL "$CHECKSUM_URL" -o "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
    MATCHES="$(awk -v name="$TARBALL_NAME" '$1 ~ /^[0-9a-fA-F]{64}$/ && ($2 == name || $2 == "*" name) { print $1 }' "$TMP_DIR/SHA256SUMS")"
    MATCH_COUNT="$(printf '%s\n' "$MATCHES" | awk 'NF { count++ } END { print count + 0 }')"
    if [ "$MATCH_COUNT" = 1 ]; then
      EXPECT="$MATCHES"
      ACTUAL="$(sha256sum "$TARBALL_ACTUAL" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$TARBALL_ACTUAL" | awk '{print $1}')"
      if [ "$ACTUAL" != "$EXPECT" ]; then
        echo -e "  ${RED}Checksum mismatch for $TARBALL_NAME${RESET}"
        echo -e "  ${DIM}expected: $EXPECT${RESET}"
        echo -e "  ${DIM}actual:   $ACTUAL${RESET}"
        exit 1
      fi
      echo -e "  ${GREEN}SHA-256 verified against the release manifest${RESET}"
    else
      echo -e "  ${YELLOW}SHA256SUMS must contain exactly one valid entry for $TARBALL_NAME${RESET}"
      [ "${MONA_REQUIRE_CHECKSUM:-0}" = 1 ] && exit 1
    fi
  else
    echo -e "  ${YELLOW}Release manifest (SHA256SUMS) missing — cannot verify${RESET}"
    [ "${MONA_REQUIRE_CHECKSUM:-0}" = 1 ] && exit 1
  fi
fi

tar xz -C "$TMP_DIR" --strip-components=1 -f "$TARBALL_ACTUAL"

# ── Version match (release installs) ────────────────────────────
if [ -n "$VERSION_REQ" ]; then
  EXTRACTED="$(node -p "require('$TMP_DIR/package.json').version" 2>/dev/null || echo '')"
  REQ_TAG="${VERSION_REQ#v}"
  if [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "$REQ_TAG" ]; then
    echo -e "  ${RED}Extracted version v$EXTRACTED does not match requested tag $VERSION_REQ${RESET}"
    exit 1
  fi
fi

# ── Dependencies ────────────────────────────────────────────────
echo -e "  ${DIM}Installing dependencies${RESET}"
( cd "$TMP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent )

# ── Copy into place (clean replace; config lives outside agent/) ─
rm -rf "$INSTALL_DIR/agent"
mkdir -p "$INSTALL_DIR/agent"
cp -R "$TMP_DIR"/. "$INSTALL_DIR/agent/"
chmod +x "$INSTALL_DIR/agent/apps/desktop/bin/mona-agent.js"

# ── Symlink + PATH for the current shell ────────────────────────
BIN_DIR="$HOME/.local/bin"
if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
  BIN_DIR="$HOME/bin"
  mkdir -p "$BIN_DIR"
fi
ln -sf "$INSTALL_DIR/agent/apps/desktop/bin/mona-agent.js" "$BIN_DIR/mona-agent"
echo -e "  Symlink:   ${BOLD}$BIN_DIR/mona-agent${RESET}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) export PATH="$BIN_DIR:$PATH" ;;
esac

# ── Persist PATH for future shells (idempotent) ─────────────────
BIN_REL="${BIN_DIR/#$HOME\//}"
rc_touched=""
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  grep -qF "$BIN_DIR" "$rc" && continue
  grep -qF "\$HOME/$BIN_REL" "$rc" && continue
  grep -qF "~/$BIN_REL" "$rc" && continue
  printf '\n# added by mona-agent installer (keeps `mona-agent` on PATH)\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
  rc_touched="$rc_touched $rc"
  echo -e "  PATH:       added to ~${rc#$HOME}"
done
if [ -z "$rc_touched" ] && [ ! -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.profile" ]; then
  printf '\n# added by mona-agent installer (keeps `mona-agent` on PATH)\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.profile"
  echo -e "  PATH:       created ~/.profile"
fi

echo ""
echo -e "  ${GREEN}mona-agent installed!${RESET}  ${DIM}(ref: $REF${VERSION_REQ:+, checksum-verified})${RESET}"
echo ""
echo -e "  ${BOLD}Enjoying mona-agent?${RESET}  Star us on GitHub:"
echo -e "  ${CYAN}https://github.com/MONAEXPERT/agent${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Get your API key:   ${CYAN}https://agent.mona.expert/dashboard${RESET}"
echo -e "  2. Login:              ${CYAN}mona-agent login${RESET}"
echo -e "  3. Dashboard:          ${CYAN}mona-agent gui${RESET}   ${DIM}(headless: mona-agent start)${RESET}"
echo ""
echo -e "  ${DIM}PATH was set for this shell too — 'mona-agent' works right now.${RESET}"
echo -e "  ${DIM}New terminals pick it up automatically.${RESET}"
echo ""
