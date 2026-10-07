#!/usr/bin/env bash
# One command: apply a scenario to a running bench, drive the right load, check the symptoms, print a report next to the expected result, reset.
#   lab/bench-scenario.sh shopflow sf-05-secret-rotation [load_seconds=60]
#   KEEP=1 lab/bench-scenario.sh ledgerline ll-02-provider-outage      # leave the scenario applied afterwards
# Run it ON the instance (needs docker, make, curl). Output is also saved to ~/bench-results/<scenario>-<time>.txt -- paste that to whoever is helping.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBJECT="${1:?subject: shopflow|ledgerline}"; ID="${2:?scenario id, e.g. sf-05-secret-rotation}"; DUR="${3:-60}"
SPEC="$ROOT/$SUBJECT/scenarios/$ID/scenario.yaml"; [ -f "$SPEC" ] || { echo "no such scenario: $ID (see: make -C $SUBJECT scenarios)" >&2; exit 2; }
SUDO=""; docker info >/dev/null 2>&1 || SUDO="sudo"
D="$SUDO docker"; MK="$SUDO env GRAFANA_PASSWORD=${GRAFANA_PASSWORD:-bench} make -C $ROOT/$SUBJECT"
mkdir -p "$HOME/bench-results"; OUT="$HOME/bench-results/$ID-$(date +%H%M%S).txt"
say() { echo -e "$*" | tee -a "$OUT"; }

# heavy load that triggers each scenario: concurrency | think-ms | mix | users
declare -A LOAD=(
 [sf-01-missing-index]="40|0|browse=20,cart=70,checkout=10|500" [sf-02-cache-thrash]="40|0|browse=100|500" [sf-03-unbounded-cache]="30|0|browse=0,cart=100,checkout=0|2000000"
 [sf-04-retry-storm]="30|0|browse=0,cart=0,checkout=100|200" [sf-05-secret-rotation]="10|50|browse=40,cart=40,checkout=20|200" [sf-06-shadow-dependency]="10|50|browse=30,cart=30,checkout=40|200"
 [sf-07-dead-dependency]="10|50|browse=100|200" [sf-08-noisy-neighbor]="20|0|browse=20,cart=30,checkout=50|300" [sf-09-cpu-throttle]="40|0|browse=100|500"
 [sf-10-poison-message]="5|20|browse=0,cart=0,checkout=100|500" [sf-11-wrong-hostname]="10|50|browse=30,cart=70|200" [sf-00-baseline]="10|100||200"
 [ll-01-pool-starvation-cycle]="40|0|profile=100,transfer=0,fx-transfer=0,statement=0|1" [ll-02-provider-outage]="10|20|transfer=60,fx-transfer=40,profile=0,statement=0|1"
 [ll-03-hot-row]="40|0|transfer=100,fx-transfer=0,profile=0,statement=0|1" [ll-04-connection-budget]="50|0|transfer=90,statement=10,fx-transfer=0,profile=0|1"
 [ll-05-batch-oom]="10|50|transfer=90,statement=10,fx-transfer=0,profile=0|1" [ll-06-shadow-dependency]="10|50|transfer=40,fx-transfer=60,profile=0,statement=0|1" [ll-00-baseline]="10|100||1")
IFS='|' read -r CONC THINK MIX USERS <<<"${LOAD[$ID]:-10|100||100}"
if [ "$SUBJECT" = shopflow ]; then GW="http://localhost:8080"; NET=shopflow_default; BASE=http://api-gateway:8080; else GW="http://localhost:8081"; NET=ledgerline_default; BASE=http://edge:8081; fi

probe() {   # status codes of one request per public endpoint
  local c=(curl -s -o /dev/null -m 8 -w '%{http_code}')
  if [ "$SUBJECT" = shopflow ]; then
    local u="probe-$RANDOM"
    echo "catalog_list=$("${c[@]}" "$GW/api/catalog/products?limit=2") product=$("${c[@]}" "$GW/api/catalog/products/1") cart_add=$("${c[@]}" -X POST "$GW/api/cart/$u/items" -H 'content-type: application/json' -d '{"productId":1,"qty":1,"priceCents":1000}') orders=$("${c[@]}" "$GW/api/orders?userId=$u") checkout=$("${c[@]}" -X POST "$GW/api/checkout" -H 'content-type: application/json' -d "{\"userId\":\"$u\"}")  (409 = empty cart is a normal answer for the checkout probe)"
  else
    echo "account=$("${c[@]}" "$GW/api/accounts/acct-00010") risk_profile=$("${c[@]}" "$GW/api/accounts/acct-00010/risk-profile") statement=$("${c[@]}" "$GW/api/statements/acct-00010") transfer=$("${c[@]}" -X POST "$GW/api/transfers" -H 'content-type: application/json' -H "Idempotency-Key: $RANDOM$RANDOM" -d '{"from":"acct-00010","to":"acct-02500","amountCents":500,"currency":"USD"}')"
  fi
}
containers() { $D ps -a --format '{{.Names}}' | grep -E "^$SUBJECT-" | grep -v -- "-obs-" | sort | while read n; do
  $D inspect "$n" --format '{{printf "%-32s" .Name}} {{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}' | sed "s#/$SUBJECT-##; s#-1 # #"; done; }

say "################ $SUBJECT / $ID   ($(date -u +%H:%M:%S) UTC, load ${DUR}s: concurrency=$CONC think=${THINK}ms mix=${MIX:-default})"
say "\n== applying scenario"; $MK scenario SCEN="$ID" >>"$OUT" 2>&1 || say "(make scenario reported an error; see $OUT)"
for i in $(seq 1 40); do curl -s -o /dev/null -m 3 "$GW/api/$([ $SUBJECT = shopflow ] && echo catalog/products?limit=1 || echo accounts/acct-00001)" && break; sleep 3; done
say "\n== BEFORE load (15 s after apply)"; sleep 15; say "$(probe)"
say "\n== load"
EXTRA=(); [ -n "$MIX" ] && EXTRA=(--mix "$MIX")
$D run --rm --network "$NET" "$SUBJECT/traffic:dev" node loadgen/loadgen.mjs --base "$BASE" --concurrency "$CONC" --duration "$DUR" --users "$USERS" --think-ms "$THINK" "${EXTRA[@]}" 2>/tmp/lg.err | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print('overall :',d['overall'],'| rps',d['rps']); print('statuses:',d['status'])
    for v in d['routes'].values(): print('  ',v)
except Exception as e: print('(no load summary)',e)" | tee -a "$OUT"
say "last 3 load ticks: $(grep -E '^[0-9]{2}:' /tmp/lg.err | tail -3 | tr '\n' ' ')"
say "\n== DURING/AFTER load"; say "$(probe)"; say "\n== containers (state, restarts, OOM)"; say "$(containers)"
say "\n== what this scenario should look like (from $SUBJECT/scenarios/$ID/scenario.yaml)"
say "$(awk '/^(title|summary|production_condition):/ {p=1} /^(ground_truth|mapper_signals|mapper_blind_spots):/ {p=1} /^(measured|run|load|why_|timeline|expect|fix|verified|class|id):/ {p=0} p' "$SPEC" | cut -c1-220 | head -40)"
if [ -z "${KEEP:-}" ] && [ "$ID" != "$SUBJECT-00-baseline" ] && [ "$ID" != sf-00-baseline ] && [ "$ID" != ll-00-baseline ]; then
  BASEID=$([ "$SUBJECT" = shopflow ] && echo sf-00-baseline || echo ll-00-baseline); say "\n== resetting to $BASEID"; $MK scenario SCEN="$BASEID" >>"$OUT" 2>&1; fi
say "\nreport saved to $OUT"
