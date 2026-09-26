#!/bin/sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$SCRIPT_DIR"
# The same script is copied into Start-Dashboard.app/Contents/Resources; when the
# bundle launches it, climb to the project folder that holds index.html.
while [ "$DIR" != "/" ] && [ ! -f "$DIR/index.html" ]; do
  DIR="$(dirname "$DIR")"
done
if [ ! -f "$DIR/index.html" ]; then
  echo "index.html not found above $SCRIPT_DIR - keep Start-Dashboard.app in the dashboard folder" >&2
  exit 1
fi
PORT=8000
LOG="${TMPDIR:-/tmp}/ibkr-dashboard-$PORT.log"
PIDS=$(lsof -ti:$PORT -sTCP:LISTEN || true)
if [ -n "$PIDS" ]; then
  echo "Killing $PIDS on :$PORT"
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 2
  REMAIN=$(lsof -ti:$PORT -sTCP:LISTEN || true)
  [ -n "$REMAIN" ] && echo "$REMAIN" | xargs kill -9 2>/dev/null || true
  sleep 1
fi
cd "$DIR"
nohup python3 -m http.server $PORT --bind 127.0.0.1 >"$LOG" 2>&1 &
for i in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.5
done
URL="http://127.0.0.1:$PORT/index.html"
# Open preference (logged): an installed Brave PWA app-window for this origin,
# else a Brave --app window on the default profile, else Brave by name, else
# the default browser. Installed PWAs live in ~/Applications as app bundles
# whose Info.plist names the shortcut URL.
MODE=""
for APP in "$HOME/Applications/Brave Browser Apps.localized"/*.app; do
  [ -d "$APP" ] || continue
  SHORTCUT=$(/usr/libexec/PlistBuddy -c 'Print :CrAppModeShortcutURL' \
    "$APP/Contents/Info.plist" 2>/dev/null || true)
  case "$SHORTCUT" in
    "http://127.0.0.1:$PORT"*)
      open "$APP"
      MODE="installed app window: $APP"
      break
      ;;
  esac
done
if [ -z "$MODE" ]; then
  BRAVE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  if [ -x "$BRAVE" ]; then
    "$BRAVE" --app="$URL" >/dev/null 2>&1 &
    MODE="Brave app window"
  elif open -a "Brave Browser" --args --app="$URL" 2>/dev/null; then
    MODE="Brave app window (via open -a)"
  else
    open "$URL"
    MODE="default browser"
  fi
fi
echo "Opened with: $MODE"
echo "launched: $MODE" >>"$LOG"
echo "Serving $DIR on http://127.0.0.1:$PORT (log $LOG)"
