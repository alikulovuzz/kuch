#!/usr/bin/env bash
# Runs the API and the Vite dev server together, for local development without Docker.
#
#   ./dev.sh                  # API on :3000, app on http://localhost:5173
#   WEB_PORT=5174 ./dev.sh    # any of the variables below can be overridden the same way
#   .\dev.cmd                 # from PowerShell or cmd on Windows (runs this with Git Bash)
#
# Ctrl+C stops both; if either one exits, the other is stopped too. Data goes to ./data, the
# same folder docker compose uses. .env is not read: its ORIGIN is the Docker one (:8080), and
# passkeys only work when ORIGIN is exactly the address in the browser bar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"

export PORT
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export RP_ID="${RP_ID:-localhost}"
export ORIGIN="${ORIGIN:-http://localhost:$WEB_PORT}"
# vite.config.js: where /api is proxied to, and the Origin it presents to the API's CSRF guard.
export API_TARGET="http://127.0.0.1:$PORT"
export API_ORIGIN="$ORIGIN"

for dir in api frontend; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    echo "==> installing $dir dependencies"
    (cd "$ROOT/$dir" && npm ci)
  fi
done
mkdir -p "$DATA_DIR"

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> API on :$PORT (data in $DATA_DIR)"
(cd "$ROOT/api" && exec node server.js) &
pids+=($!)

# Start Vite only once the API answers, so the first page load doesn't hit a dead proxy.
health="http://127.0.0.1:$PORT/api/health"
for _ in $(seq 1 60); do
  if node -e "fetch('$health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then break; fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then echo "API exited during startup" >&2; exit 1; fi
  sleep 0.5
done

echo "==> app on $ORIGIN"
# --host: also reachable from other devices on the network (a phone), at the Network address Vite
# prints. Passkeys need HTTPS or localhost, so over a LAN address use guest mode or PASSWORD_LOGIN=1.
(cd "$ROOT/frontend" && exec node node_modules/vite/bin/vite.js --host --port "$WEB_PORT" --strictPort) &
pids+=($!)

wait -n
