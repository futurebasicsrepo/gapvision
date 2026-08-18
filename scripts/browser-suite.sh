#!/usr/bin/env bash
#
# Stand up the local stack and run a browser suite against it.
#
#   scripts/browser-suite.sh gestures
#   scripts/browser-suite.sh console
#   scripts/browser-suite.sh widgets
#
# Why this exists
# ---------------
# The browser suites each documented "expects `vite preview` on :51xx plus the
# realtime + AI services running", which is true and is not enough. Three
# things were missing from that sentence, and every one of them fails as a
# *timeout on a selector* rather than as a message about the thing that is
# actually wrong:
#
#   1. The AI service fails closed unless GAPVISION_AUTH_MODE=demo. Without
#      it `/api/guests` answers "Service is not configured to serve this
#      tenant", the beacon roster renders an error string, and the suite waits
#      thirty seconds for a button that is never coming.
#   2. The plugin bakes its server URL in at *build* time. A plain build points
#      the preview at production Railway, so the page under test talks to the
#      wrong server entirely.
#   3. The console suite needs two real accounts. `db:seed --demo` makes them,
#      but only with the passwords pinned — otherwise it generates a fresh one
#      each run and prints it, which no test can consume.
#
# Requires a reachable Postgres in CUE_DATABASE_URL. Everything else is
# started here and stopped on the way out.
set -euo pipefail

SUITE="${1:-}"
if [ -z "$SUITE" ]; then
  echo "usage: scripts/browser-suite.sh <gestures|console|leads|widgets|floor-dm|pocket>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${CUE_DATABASE_URL:?set CUE_DATABASE_URL to a reachable Postgres}"

AI_PORT="${AI_PORT:-8000}"
RT_PORT="${RT_PORT:-4000}"
RT_URL="http://localhost:${RT_PORT}"
LOGS="$(mktemp -d)"

# Pinned so the console suite can actually sign in. Local dev database only —
# these are seeded accounts in a throwaway Postgres, not credentials for
# anything that exists outside this machine.
# `.example.com`, not `.test` — the login route's email validator rejects
# reserved TLDs, so a `.test` address seeds fine and then cannot sign in.
export CUE_ADMIN_EMAIL="${CUE_ADMIN_EMAIL:-staff@cuesea.example.com}"
export CUE_ADMIN_PASSWORD="${CUE_ADMIN_PASSWORD:-local-dev-staff-pw}"
export CUE_DEMO_PASSWORD="${CUE_DEMO_PASSWORD:-local-dev-demo-pw}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for() {  # url, label
  for _ in $(seq 1 40); do
    curl -sf "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "!! $2 never came up — see $LOGS" >&2
  return 1
}

echo "== migrate + seed"
( cd packages/ai-service && python -c "from app import db; db.migrate()" >"$LOGS/migrate.log" 2>&1 ) \
  || { tail -20 "$LOGS/migrate.log"; exit 1; }
( cd packages/ai-service && python -m app.seed --demo >"$LOGS/seed.log" 2>&1 ) \
  || { tail -20 "$LOGS/seed.log"; exit 1; }

echo "== ai service (demo auth) on :$AI_PORT"
( cd packages/ai-service && GAPVISION_AUTH_MODE=demo \
    python -m uvicorn app.main:app --port "$AI_PORT" >"$LOGS/ai.log" 2>&1 ) &
PIDS+=($!)
wait_for "http://localhost:$AI_PORT/health" "ai service"

echo "== realtime on :$RT_PORT"
PORT="$RT_PORT" AI_SERVICE_URL="http://localhost:$AI_PORT" \
  node packages/server/src/index.js >"$LOGS/rt.log" 2>&1 &
PIDS+=($!)
wait_for "$RT_URL/health" "realtime server"

# Each suite: the package to build and preview, and the port it expects.
case "$SUITE" in
  gestures|widgets|floor-dm) PKG="glasses-plugin"; PORT=5180 ;;
  console|leads)             PKG="internal";      PORT=5176 ;;
  pocket)                    PKG="pocket";        PORT=5178 ;;
  *) echo "unknown suite: $SUITE" >&2; exit 2 ;;
esac

echo "== build $PKG against $RT_URL"
VITE_SERVER_URL="$RT_URL" VITE_API_URL="$RT_URL" \
  npm run --silent build --workspace="packages/$PKG" >"$LOGS/build.log" 2>&1 \
  || { tail -25 "$LOGS/build.log"; exit 1; }

echo "== preview on :$PORT"
( cd "packages/$PKG" && npx vite preview --port "$PORT" >"$LOGS/preview.log" 2>&1 ) &
PIDS+=($!)
wait_for "http://localhost:$PORT/" "$PKG preview"

case "$SUITE" in
  gestures) TEST="packages/glasses-plugin/test/gestures-browser.mjs" ;;
  widgets)  TEST="packages/glasses-plugin/test/widgets-browser.mjs" ;;
  floor-dm) TEST="packages/glasses-plugin/test/floor-dm-browser.mjs" ;;
  pocket)   TEST="packages/pocket/test/pocket-browser.mjs" ;;
  leads)    TEST="packages/internal/test/leads-browser.mjs" ;;
  console)
    TEST="packages/internal/test/console-browser.mjs"
    export CONSOLE_STAFF_EMAIL="$CUE_ADMIN_EMAIL"
    export CONSOLE_STAFF_PASSWORD="$CUE_ADMIN_PASSWORD"
    export CONSOLE_TENANT_EMAIL="admin@example.com"
    export CONSOLE_TENANT_PASSWORD="$CUE_DEMO_PASSWORD"
    ;;
esac

echo "== $SUITE"
node "$TEST"
