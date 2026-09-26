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
open "http://127.0.0.1:$PORT/index.html"
echo "Serving $DIR on http://127.0.0.1:$PORT (log $LOG)"
