#!/bin/sh
# GoodComments installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/sdezubiria/goodcomments/main/install.sh | sh
#
# What it does (run it again any time to update):
#   1. downloads GoodComments into ~/.goodcomments/app (your comments stay in ~/.goodcomments)
#   2. puts the `gc` command on your PATH
#   3. builds the menu bar app into ~/Applications/GoodComments.app and opens it
#   4. registers the MCP server with Claude Code, if Claude Code is installed
#
# Skip steps with GOODCOMMENTS_SKIP_APP=1 (no menu bar app) or GOODCOMMENTS_SKIP_MCP=1.
set -e

REPO="https://github.com/sdezubiria/goodcomments.git"
HOME_DIR="$HOME/.goodcomments"
APP_DIR="$HOME_DIR/app"
BIN_DIR="$HOME/.local/bin"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "GoodComments' menu bar app is macOS only (the server and CLI also run elsewhere: see the README)."

# --- requirements ------------------------------------------------------------
command -v git  >/dev/null 2>&1 || fail "git is missing. Install the Xcode Command Line Tools: xcode-select --install"
command -v node >/dev/null 2>&1 || fail "Node.js 22.13 or newer is needed: https://nodejs.org (or: brew install node)"
NODE_OK=$(node -e "const [a,b]=process.versions.node.split('.').map(Number); console.log(a>22||(a===22&&b>=13)?1:0)")
[ "$NODE_OK" = "1" ] || fail "Node.js $(node -v) is too old; GoodComments needs 22.13 or newer (it uses the built-in SQLite)."

# --- 1. download / update ----------------------------------------------------
mkdir -p "$HOME_DIR"
if [ -d "$APP_DIR/.git" ]; then
  say "Updating GoodComments in $APP_DIR"
  git -C "$APP_DIR" pull --ff-only --quiet
else
  say "Downloading GoodComments into $APP_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP_DIR"
fi

# --- 2. the gc command -------------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$APP_DIR/bin/gc.js"
ln -sf "$APP_DIR/bin/gc.js" "$BIN_DIR/gc"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "Add $BIN_DIR to your PATH to use gc everywhere:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

# --- 3. the menu bar app -----------------------------------------------------
if [ -n "$GOODCOMMENTS_SKIP_APP" ]; then
  say "Skipping the menu bar app (GOODCOMMENTS_SKIP_APP)"
elif command -v swiftc >/dev/null 2>&1 || [ -d /Applications/Xcode.app ]; then
  say "Building the menu bar app"
  sh "$APP_DIR/mac/build.sh" >/dev/null
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/GoodComments.app"
  cp -R "$APP_DIR/mac/build/GoodComments.app" "$HOME/Applications/"
  # tell the app where its server lives
  defaults write local.goodcomments.edge root "$APP_DIR"
  pkill -f "GoodComments.app/Contents/MacOS/GoodComments" 2>/dev/null || true
  open "$HOME/Applications/GoodComments.app" || true
  sleep 2
  pgrep -f "GoodComments.app/Contents/MacOS/GoodComments" >/dev/null 2>&1 \
    || warn "The menu bar app didn't start. If macOS blocked it, open System Settings > Privacy & Security and click Open Anyway, then: open ~/Applications/GoodComments.app"
else
  warn "Skipped the menu bar app: it needs Swift (xcode-select --install). The board still works in the browser: gc open"
fi

# --- 4. agents -----------------------------------------------------------------
if [ -z "$GOODCOMMENTS_SKIP_MCP" ] && command -v claude >/dev/null 2>&1; then
  if claude mcp get goodcomments >/dev/null 2>&1; then
    say "Claude Code already has the goodcomments MCP server"
  else
    claude mcp add goodcomments -s user -e GOODCOMMENTS_ACTOR=claude -- node "$APP_DIR/bin/gc.js" mcp >/dev/null && say "Registered the goodcomments MCP server with Claude Code"
  fi
fi

say ""
say "GoodComments is installed."
echo "  • Rest your pointer on the right edge of the screen (or press ⌃⌥C) to open the column."
echo "  • Start a project from a repo:   cd my-repo && gc project add \"My repo\" --path ."
echo "  • Add a comment:                 gc add \"The logo is blurry on mobile\""
echo "  • Agents: see $APP_DIR/AGENTS.md"
