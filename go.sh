#!/usr/bin/env bash
set -euo pipefail

# go.sh — launch p2p-chat for local development.
#
#   ./go.sh              run inside the ARCADE FRAMEWORK (launcher + game in an
#                        iframe, with the postMessage/SDK handshake and shared
#                        localStorage). This is the real environment — use it to
#                        test pairing/multiplayer via the launcher's Multiplayer
#                        menu (standalone mode has no peer, Arcade.peer.status()
#                        is 'unavailable').
#   ./go.sh standalone   run the game on its own (no launcher chrome), the old
#                        fast-iteration server in a fresh Safari private window.
#   ./go.sh stop         stop both servers.
#
# Arcade mode delegates to the launcher repo's dev.sh (the maintained staging
# tool), located at ../paulgibeault.github.io or $ARCADE_LAUNCHER.

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.go.pid"
PORT_FILE="$DIR/.go.port"
LOG_FILE="$DIR/.go.log"
LAUNCHER_DIR="${ARCADE_LAUNCHER:-$DIR/../paulgibeault.github.io}"

# ─── standalone server (game only, no launcher) ──────────────────────────────
run_standalone() {
  # index.html loads /arcade-sdk.js as an absolute path (the production
  # origin). A standalone server has nothing at that path, so mirror it in via
  # a symlink to the sibling launcher repo — kept fresh across launcher edits,
  # unlike a one-time copy. Gitignored; not meant to be committed.
  SDK_LINK="$DIR/arcade-sdk.js"
  SDK_SRC="$LAUNCHER_DIR/arcade-sdk.js"
  if [ -f "$SDK_SRC" ]; then
    if [ ! -L "$SDK_LINK" ] || [ "$(readlink "$SDK_LINK")" != "$SDK_SRC" ]; then
      ln -sf "$SDK_SRC" "$SDK_LINK"
    fi
  else
    echo "WARNING: $SDK_SRC not found — standalone mode will fail to load the Arcade SDK." >&2
    echo "         Clone paulgibeault/paulgibeault.github.io as a sibling directory, or set ARCADE_LAUNCHER." >&2
  fi

  # Kill previous standalone run if pid file exists.
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      for i in 1 2 3 4 5; do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 0.2
      done
      echo "Stopped previous instance (PID $OLD_PID)"
    fi
    rm -f "$PID_FILE"
  fi

  # Sweep any orphan http.server processes still bound to this directory — a
  # prior run that crashed without removing its pid file would otherwise hold
  # its port forever. We match strictly on "--directory $DIR" so sibling
  # projects' servers are left alone.
  ORPHANS=$(ps -axo pid=,command= \
    | awk -v dir="$DIR" '
        $0 ~ "http\\.server" {
          needle = "--directory " dir
          p = index($0, needle)
          if (p > 0) {
            # Require the directory argument to end here (space or EOL), not be
            # a prefix of a subdirectory like .arcade-stage.
            tail = substr($0, p + length(needle), 1)
            if (tail == "" || tail == " ") print $1
          }
        }')
  if [ -n "$ORPHANS" ]; then
    for ORPHAN in $ORPHANS; do
      kill "$ORPHAN" 2>/dev/null || true
    done
    echo "Cleaned orphan server(s): $ORPHANS"
    sleep 0.3
  fi

  # Rotate the port on every run. ES module imports are aggressively cached by
  # origin, so reusing the same port lets stale module bytes survive even a
  # hard refresh. A fresh port = a fresh origin = guaranteed fresh modules.
  pick_port() {
    for i in 1 2 3 4 5 6 7 8 9 10; do
      local p=$((8000 + RANDOM % 1000))
      if ! lsof -ti "tcp:$p" >/dev/null 2>&1; then
        echo "$p"
        return 0
      fi
    done
    return 1
  }
  PORT=$(pick_port) || { echo "Could not find a free port in 8000-8999"; exit 1; }

  python3 -m http.server "$PORT" --directory "$DIR" > "$LOG_FILE" 2>&1 &
  NEW_PID=$!

  sleep 0.3
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "Failed to start server. Check $LOG_FILE"
    exit 1
  fi

  echo "$NEW_PID" > "$PID_FILE"
  echo "$PORT" > "$PORT_FILE"

  echo "Standalone server running (PID $NEW_PID)"
  echo "  URL: http://localhost:$PORT"
  echo "  Log: $LOG_FILE"

  # Open the URL in a fresh Safari Private window. Safari has no CLI flag for
  # private browsing, so we drive it via AppleScript: Cmd+Shift+N spawns a new
  # private window, then we point its tab at our URL.
  URL="http://localhost:$PORT"
  osascript <<APPLESCRIPT
tell application "Safari" to activate
delay 0.3
tell application "System Events" to keystroke "n" using {command down, shift down}
delay 0.5
tell application "Safari" to set URL of current tab of front window to "$URL"
APPLESCRIPT
}

stop_standalone() {
  if [ -f "$PID_FILE" ]; then
    local p
    p=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      echo "Stopped standalone server (PID $p)"
    fi
    rm -f "$PID_FILE"
  fi
}

# ─── arcade framework (launcher + game) ──────────────────────────────────────
require_launcher() {
  if [ ! -x "$LAUNCHER_DIR/dev.sh" ]; then
    echo "Arcade launcher not found at: $LAUNCHER_DIR" >&2
    echo "Clone/locate the launcher repo (paulgibeault.github.io) beside this" >&2
    echo "repo, or set ARCADE_LAUNCHER to its path. For game-only iteration use:" >&2
    echo "  ./go.sh standalone" >&2
    exit 1
  fi
}

run_arcade() {
  require_launcher
  echo "→ Launching p2p-chat inside the arcade framework via $LAUNCHER_DIR/dev.sh"
  # dev.sh stages the launcher + this game under one same-origin server, rewrites
  # absolute URLs to the local origin, serves it, and opens the launcher. The
  # p2p-chat tile loads the game in its iframe with the full SDK handshake —
  # needed for pairing/multiplayer (standalone mode has no peer).
  exec "$LAUNCHER_DIR/dev.sh" "$DIR"
}

# ─── dispatch ────────────────────────────────────────────────────────────────
case "${1:-arcade}" in
  arcade|"")    run_arcade ;;
  standalone)   run_standalone ;;
  stop)
    stop_standalone
    if [ -x "$LAUNCHER_DIR/dev.sh" ]; then
      "$LAUNCHER_DIR/dev.sh" stop || true
    fi
    ;;
  *)
    echo "Usage: $0 [arcade|standalone|stop]" >&2
    exit 1
    ;;
esac
