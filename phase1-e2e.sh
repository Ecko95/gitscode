#!/usr/bin/env bash
set -euo pipefail

WT=/home/ops/dev/projects/gitscode-autonomy-phase1
SCRATCH=$HOME/tmp/phase1-e2e
PORT=39775
BASE="http://127.0.0.1:${PORT}"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/t3home" "$SCRATCH/home" "$SCRATCH/fake-repo"

# Deny window: a 1-minute London window guaranteed not to cover "now".
LONDON_HM=$(TZ=Europe/London date +%H:%M)
if [[ "$LONDON_HM" > "12:00" && "$LONDON_HM" < "12:02" ]] || [[ "$LONDON_HM" == "12:00" ]]; then
  DENY_SLOTS='[{"days":"all","start":"03:00","end":"03:01"}]'
else
  DENY_SLOTS='[{"days":"all","start":"12:00","end":"12:01"}]'
fi
ALLOW_SLOTS='[{"days":"all","start":"00:00","end":"23:59"}]'
echo "London now: $LONDON_HM | deny=$DENY_SLOTS"

cd "$WT"
BEARER=$(node apps/server/src/bin.ts auth session issue --base-dir "$SCRATCH/t3home" --role owner --token-only)
echo "bearer minted (${#BEARER} chars)"

SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

boot_server() { # $1=slots json  $2=logfile
  env HOME="$SCRATCH/home" T3CODE_HOME="$SCRATCH/t3home" \
    GITS_AUTOMODE_DRIVER_TICK_MS=1500 \
    GITS_SCHEDULER_SLOTS_JSON="$1" \
    node apps/server/src/bin.ts serve --host 127.0.0.1 --port "$PORT" >"$2" 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 60); do
    sleep 1
    ss -tln | grep -q ":${PORT} " || continue
    code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST -H "authorization: Bearer $BEARER" "$BASE/api/auth/ws-token" || echo 000)
    if [ "$code" = "200" ]; then
      echo "server up (pid $SERVER_PID) after ${i}s"; return 0
    fi
  done
  echo "server failed to come up"; tail -20 "$2"; exit 1
}

drive() { # $1=phase
  (cd apps/server && env T3_BASE="$BASE" T3_BEARER="$BEARER" E2E_REPO="$SCRATCH/fake-repo" node phase1-e2e-driver.ts "$1")
}

echo "=== SERVER A (deny slots) ==="
boot_server "$DENY_SLOTS" "$SCRATCH/serverA.log"
drive enable-arm
drive seed-goal
drive expect-queued
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true
echo "server A killed while ARMED"

echo "=== SERVER B (allow slots) ==="
boot_server "$ALLOW_SLOTS" "$SCRATCH/serverB.log"
drive expect-boot-disarm
drive rearm-after-boot
drive expect-dispatch
drive snap
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true

echo "=== E2E PASS: deny, boot-disarm, re-arm, dispatch all verified ==="