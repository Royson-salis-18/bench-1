#!/usr/bin/env bash
# A staged, realistic cascading failure that starts in ORDERS and spreads to everything connected to it, under real customer load.
#   lab/cascade.sh shopflow [orders]            ~3 minutes; saves the report to ~/bench-results/
#
# Why this is organic (no service is made to "fake" an error; each hop fails for its own real reason):
#   1. baseline        real checkout/cart/browse load, everything healthy
#   2. brownout        orders loses CPU (noisy neighbour / runaway query / bad deploy). It stays UP and healthy-looking but slow.
#                      -> gateway: requests to /api/orders and /api/checkout hold connections until the 10 s read timeout, then 504
#                      -> customers' sessions block on checkout, so *browsing* slows too (closed-loop users are stuck)
#                      -> notifier: its call to orders (2 s timeout) fails, the message is NAK'd and redelivered -> the NATS backlog grows
#   3. hang            orders stops answering entirely (frozen process) -> hard 5xx/504 at the gateway, notifier retries burn the
#                      redelivery budget (max 5) so confirmations are lost for good
#   4. recovery        orders healed: watch the backlog drain, retries pile onto a cold service, and the gateway recover
# Needs the bench running with observability (make bench). Run it ON the instance.
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBJECT="${1:-shopflow}"; ROOTSVC="${2:-orders}"
[ "$SUBJECT" = shopflow ] && [ "$ROOTSVC" = orders ] || { echo "only: lab/cascade.sh shopflow orders" >&2; exit 2; }
SUDO=""; docker info >/dev/null 2>&1 || SUDO="sudo"; D="$SUDO docker"
CH="$ROOT/lab/chaos.sh"; GW=http://localhost:8080
T_BASE="${T_BASE:-25}"; T_BROWN="${T_BROWN:-45}"; T_HANG="${T_HANG:-30}"; T_RECOVER="${T_RECOVER:-60}"
TOTAL=$((T_BASE+T_BROWN+T_HANG+T_RECOVER))
OUT="$HOME/bench-results/cascade-orders-$(date +%H%M%S).txt"; mkdir -p "$HOME/bench-results"; exec > >(tee "$OUT") 2>&1
LOADC=cascade-load-$$
cleanup() { $D rm -f "$LOADC" >/dev/null 2>&1; "$CH" shopflow heal >/dev/null 2>&1; }; trap cleanup EXIT

echo "== cascading failure: orders -> gateway, notifier   (total ${TOTAL}s)"
echo "connected to orders (from depends_on):"; "$CH" shopflow predict orders | sed 's/^/  /'
echo
# heavier, checkout-rich customer load on top of the always-on traffic
$D run -d --rm --name "$LOADC" --network shopflow_default shopflow/traffic:dev node loadgen/loadgen.mjs --base http://api-gateway:8080 \
  --concurrency 24 --think-ms 150 --duration $((TOTAL+5)) --users 200 --mix browse=35,cart=30,checkout=35 --timeout-ms 12000 >/dev/null || { echo "cannot start load (is shopflow/traffic:dev built?)"; exit 1; }

probe() { # name method path body -> "code ms"
  local args=(-s -o /dev/null -m 12 -w '%{http_code} %{time_total}' -X "$2")
  [ -n "$4" ] && args+=(-H 'content-type: application/json' -d "$4")
  [ "$3" = /api/checkout ] && curl -s -o /dev/null -m 3 -X POST -H 'content-type: application/json' -d '{"productId":1,"qty":1,"priceCents":537}' "$GW/api/cart/cascade-probe/items"
  curl "${args[@]}" "$GW$3" 2>/dev/null || echo "000 12.0"
}
pending() { curl -s -m 3 'localhost:9090/api/v1/query?query=sum(queue_pending_messages%7Bjob%3D%22notifier%22%7D)' | python3 -c 'import sys,json; r=json.load(sys.stdin)["data"]["result"]; print(int(float(r[0]["value"][1])) if r else "?")' 2>/dev/null || echo "?"; }
fmt() { awk -v c="$1" -v t="$2" 'BEGIN{ms=t*1000; printf "%s/%dms", c, ms}'; }

echo "waiting for the notifier backlog to drain (clean start)..."; for _ in $(seq 40); do b=$(pending); [ "$b" = 0 ] || [ "$b" = "?" ] && break; sleep 3; done
declare -A FIRST PEAKMS; PEND_PEAK=0; PHASE=baseline; BASEMAX=0; T0=$(date +%s); BASEPEND=$(pending)
printf '%-5s %-9s %-17s %-17s %-17s %-17s %s\n' t phase catalog cart orders-list checkout "notifier-backlog"
while :; do
  t=$(( $(date +%s) - T0 )); [ "$t" -ge "$TOTAL" ] && break
  if   [ $t -ge $((T_BASE+T_BROWN+T_HANG)) ] && [ $PHASE != recovery ]; then PHASE=recovery; "$CH" shopflow heal orders >/dev/null; echo "-- t=${t}s  orders healed"
  elif [ $t -ge $((T_BASE+T_BROWN)) ] && [ $PHASE = brownout ]; then PHASE=hang; "$CH" shopflow inject orders pause >/dev/null; echo "-- t=${t}s  orders FROZEN (pause)"
  elif [ $t -ge $T_BASE ] && [ $PHASE = baseline ]; then PHASE=brownout; "$CH" shopflow inject orders cpu >/dev/null; echo "-- t=${t}s  orders THROTTLED to 5% CPU (brownout)"; fi
  row=""; for p in "catalog|GET|/api/catalog/products?limit=1|" "cart|GET|/api/cart/cascade-probe|" "orders|GET|/api/orders?userId=cascade-probe|" "checkout|POST|/api/checkout|{\"userId\":\"cascade-probe\",\"email\":\"p@example.test\"}"; do
    IFS='|' read -r n m path body <<<"$p"; read -r code sec <<<"$(probe "$n" "$m" "$path" "$body")"; ms=$(awk -v t="$sec" 'BEGIN{printf "%d", t*1000}')
    bad=0; case "$code" in 000|5*) bad=1;; esac; [ "$ms" -gt 1000 ] && bad=1
    [ "$bad" = 1 ] && [ $PHASE != baseline ] && [ -z "${FIRST[$n]:-}" ] && FIRST[$n]=$t
    [ "${PEAKMS[$n]:-0}" -lt "$ms" ] && PEAKMS[$n]=$ms
    row+=$(printf '%-18s' "$code/${ms}ms"); done
  pend=$(pending); [[ "$pend" =~ ^[0-9]+$ ]] && [ "$pend" -gt "$PEND_PEAK" ] && PEND_PEAK=$pend
  if [[ "$pend" =~ ^[0-9]+$ ]]; then
    if [ $PHASE = baseline ]; then [ "$pend" -gt "$BASEMAX" ] && BASEMAX=$pend
    elif [ "$pend" -gt $((BASEMAX+10)) ] && [ -z "${FIRST[notifier]:-}" ]; then FIRST[notifier]=$t; fi; fi
  printf '%-5s %-9s %s %s\n' "${t}s" "$PHASE" "$row" "$pend"
  sleep 1
done
echo; echo "== result: how the failure spread (first time a signal went bad: 5xx/timeout or > 1 s)"
echo "  root cause            orders      (throttled at t=${T_BASE}s, frozen at t=$((T_BASE+T_BROWN))s, healed at t=$((T_BASE+T_BROWN+T_HANG))s)"
for n in orders checkout catalog cart; do printf '  %-21s %s   peak latency %dms\n' "gateway /api/$n" "$( [ -n "${FIRST[$n]:-}" ] && echo "first bad at t=${FIRST[$n]}s" || echo "stayed healthy" )" "${PEAKMS[$n]:-0}"; done
printf '  %-21s %s   peak backlog %s (start %s)\n' "notifier (async)" "$( [ -n "${FIRST[notifier]:-}" ] && echo "backlog began growing at t=${FIRST[notifier]}s" || echo "no backlog" )" "$PEND_PEAK" "$BASEPEND"
echo "  expected: orders -> checkout and orders-list at the gateway (slow, then 504) and the notifier backlog. catalog and cart staying healthy is correct: the gateway isolates routes, so the blast radius stops at what is really connected to orders."
echo; echo "Look at the mapper / Grafana during the run: the gateway turns red first, orders is the root. An RCA tool should name orders."
echo "saved: $OUT"
