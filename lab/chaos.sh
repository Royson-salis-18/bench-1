#!/usr/bin/env bash
# Fault injection + cascade ground truth for a running bench. Inject a fault into ANY service (not just the gateway), watch it spread,
# and compare what actually happened with what the dependency graph predicts. Run it ON the instance (needs docker, curl, python3).
#
#   lab/chaos.sh <subject> list                          services, their dependencies, and the faults available
#   lab/chaos.sh <subject> predict <service>             predicted blast radius (who breaks if <service> breaks), by hop
#   lab/chaos.sh <subject> inject <service> <fault>      apply a fault and leave it on
#   lab/chaos.sh <subject> heal [service]                undo every fault (or one service's)
#   lab/chaos.sh <subject> run <service> <fault> [secs]  inject, sample the system every 3 s, print timeline + prediction-vs-observed, heal
#
# faults:  stop    container stopped (connection refused)        pause   process frozen (connects, never answers -> timeouts; the nastiest)
#          cpu     throttled to 5% of a core (slow, not dead)    net     detached from the network (partition)
#          crash   SIGKILL, restart policy brings it back        flap    frozen 4 s / running 4 s, repeatedly (intermittent)
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBJECT="${1:?subject: shopflow|ledgerline}"; CMD="${2:-list}"; SVC="${3:-}"; FAULT="${4:-}"; SECS="${5:-60}"
SUDO=""; docker info >/dev/null 2>&1 || SUDO="sudo"; D="$SUDO docker"
NET="${SUBJECT}_default"; RENDERED="$ROOT/$SUBJECT/.rendered/docker-compose.yml"
case "$SUBJECT" in
  shopflow)   GW=http://localhost:8080; ENTRY=api-gateway
    PROBES=("catalog|catalog|GET|/api/catalog/products?limit=1|" "cart|cart|GET|/api/cart/chaos-probe|" "orders|orders|GET|/api/orders?userId=chaos-probe|"
            "checkout|orders|POST|/api/checkout|{\"userId\":\"chaos-probe\",\"email\":\"p@example.test\"}");;
  ledgerline) GW=http://localhost:8081; ENTRY=edge
    PROBES=("accounts|accounts|GET|/api/accounts/acct-00001/risk-profile|" "statements|statements-worker|GET|/api/statements/acct-00001|"
            "transfers|transfers|POST|/api/transfers|{\"from\":\"acct-00001\",\"to\":\"acct-05000\",\"amountCents\":100,\"currency\":\"USD\"}");;
  *) echo "subject must be shopflow or ledgerline" >&2; exit 2;;
esac
[ -f "$RENDERED" ] || { echo "no rendered compose at $RENDERED -- start the bench first (make bench)" >&2; exit 2; }

GRAPH=$(COMPOSE_PROFILES=traffic $D compose -f "$RENDERED" config --format json 2>/dev/null || COMPOSE_PROFILES=traffic docker compose -f "$RENDERED" config --format json)
py() { python3 -c "$1" <<<"$GRAPH"; }
services() { py 'import json,sys; d=json.load(sys.stdin)["services"]; print(" ".join(s for s in d if s not in ("traffic",)))'; }
deps_of() { py "import json,sys; d=json.load(sys.stdin)['services']; print(' '.join(d['$1'].get('depends_on',{}) or []))"; }
# transitive dependents by hop: "hop service" lines
radius() { py "
import json,sys
d=json.load(sys.stdin)['services']
rev={}
for s,v in d.items():
    if s=='traffic': continue
    for t in (v.get('depends_on') or {}): rev.setdefault(t,set()).add(s)
seen={'$1'}; frontier=['$1']; hop=0
while frontier:
    hop+=1; nxt=[]
    for x in frontier:
        for y in sorted(rev.get(x,())):
            if y not in seen: seen.add(y); nxt.append(y); print(hop,y)
    frontier=nxt
"; }
cid() { $D ps -aq --filter "label=com.docker.compose.project=$SUBJECT" --filter "label=com.docker.compose.service=$1" | head -1; }
need() { local c; c=$(cid "$1"); [ -n "$c" ] || { echo "no such service: $1 (try: lab/chaos.sh $SUBJECT list)" >&2; exit 2; }; echo "$c"; }
FLAPPID="/tmp/chaos-$SUBJECT-flap-"

inject() {
  local s="$1" f="$2" c; c=$(need "$s")
  case "$f" in
    stop)  $D stop -t 1 "$c" >/dev/null;;
    pause) $D pause "$c" >/dev/null;;
    cpu)   $D update --cpus 0.05 "$c" >/dev/null;;
    net)   $D network disconnect "$NET" "$c" >/dev/null;;
    crash) $D kill "$c" >/dev/null;;
    flap)  ( while true; do $D pause "$c" >/dev/null 2>&1; sleep 4; $D unpause "$c" >/dev/null 2>&1; sleep 4; done ) >/dev/null 2>&1 & echo $! > "$FLAPPID$s";;
    *) echo "unknown fault '$f' (stop|pause|cpu|net|crash|flap)" >&2; exit 2;;
  esac
}
heal_one() {
  local s="$1" c; c=$(cid "$s"); [ -n "$c" ] || return 0
  [ -f "$FLAPPID$s" ] && { kill "$(cat "$FLAPPID$s")" 2>/dev/null; rm -f "$FLAPPID$s"; }
  $D unpause "$c" >/dev/null 2>&1; $D start "$c" >/dev/null 2>&1; $D update --cpus 0 "$c" >/dev/null 2>&1
  $D network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "$($D inspect -f '{{.Name}}' "$c" | tr -d /)" || $D network connect --alias "$s" "$NET" "$c" >/dev/null 2>&1
}
heal() { if [ -n "$SVC" ]; then heal_one "$SVC"; else for s in $(services); do heal_one "$s"; done; fi; }

state() { # service state: ok | paused | down | restarting | unhealthy | detached
  local c; c=$(cid "$1"); [ -n "$c" ] || { echo missing; return; }
  local st; st=$($D inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Paused}}' "$c" 2>/dev/null)
  IFS='|' read -r run health paused <<<"$st"
  [ "$paused" = true ] && { echo paused; return; }
  [ "$run" = running ] || { echo "$run"; return; }
  $D inspect -f '{{json .NetworkSettings.Networks}}' "$c" | grep -q "\"$NET\"" || { echo detached; return; }
  [ "$health" = unhealthy ] && { echo unhealthy; return; }
  echo ok
}
probe() { # name svc method path body -> http code (000 = timeout/refused), 3 s timeout
  local m="$3" p="$4" b="$5" args=(-s -o /dev/null -m 3 -w '%{http_code}' -X "$m")
  # a real checkout needs a non-empty cart (otherwise it answers 409 and never reaches payments/inventory)
  [ "$p" = /api/checkout ] && curl -s -o /dev/null -m 3 -X POST -H 'content-type: application/json' -d '{"productId":1,"qty":1,"priceCents":537}' "$GW/api/cart/chaos-probe/items"
  [ -n "$b" ] && args+=(-H 'content-type: application/json' -H "idempotency-key: chaos-$RANDOM$RANDOM" -d "$b")
  curl "${args[@]}" "$GW$p" 2>/dev/null || true
}

case "$CMD" in
  list)
    echo "services of $SUBJECT (depends_on):"; for s in $(services); do printf '  %-18s -> %s\n' "$s" "$(deps_of "$s")"; done
    echo; echo "faults: stop pause cpu net crash flap      e.g.  lab/chaos.sh $SUBJECT run catalog-db pause 40";;
  predict)
    [ -n "$SVC" ] || { echo "usage: predict <service>" >&2; exit 2; }; need "$SVC" >/dev/null
    echo "if $SVC fails, these are affected (hop 1 = direct dependents):"; radius "$SVC" | awk '{printf "  hop %s  %s\n",$1,$2}'
    echo "gateway routes expected to degrade:"; for p in "${PROBES[@]}"; do IFS='|' read -r n s _ <<<"$p"
      if [ "$s" = "$SVC" ] || radius "$SVC" | awk '{print $2}' | grep -qx "$s"; then echo "  /api/$n (served by $s)"; fi; done;;
  inject) [ -n "$SVC" ] && [ -n "$FAULT" ] || { echo "usage: inject <service> <fault>" >&2; exit 2; }; inject "$SVC" "$FAULT"; echo "injected $FAULT into $SVC (undo: lab/chaos.sh $SUBJECT heal)";;
  heal) heal; echo "healed ${SVC:-everything}";;
  run)
    [ -n "$SVC" ] && [ -n "$FAULT" ] || { echo "usage: run <service> <fault> [secs]" >&2; exit 2; }; need "$SVC" >/dev/null
    OUT="$HOME/bench-results/chaos-$SUBJECT-$SVC-$FAULT-$(date +%H%M%S).txt"; mkdir -p "$HOME/bench-results"
    exec > >(tee "$OUT") 2>&1
    trap 'heal >/dev/null 2>&1' EXIT
    echo "== chaos run: $FAULT -> $SVC on $SUBJECT for ${SECS}s (entry point: $ENTRY)"; echo; "$0" "$SUBJECT" predict "$SVC"; echo
    declare -A FIRST_ROUTE FIRST_SVC LAST_CODE
    T0=$(date +%s); inject "$SVC" "$FAULT"; echo "-- injected at t=0"
    printf '%-5s %s\n' t "route status (000 = timeout/refused) | services not ok"
    while [ $(( $(date +%s) - T0 )) -lt "$SECS" ]; do
      t=$(( $(date +%s) - T0 )); line=""
      for p in "${PROBES[@]}"; do IFS='|' read -r n s m path body <<<"$p"; code=$(probe "$n" "$s" "$m" "$path" "$body"); line+="$n=$code "
        case "$code" in 000|5*) [ -z "${FIRST_ROUTE[$n]:-}" ] && FIRST_ROUTE[$n]=$t;; esac; done
      bad=""; for s in $(services); do st=$(state "$s"); [ "$st" != ok ] && { bad+="$s:$st "; [ -z "${FIRST_SVC[$s]:-}" ] && FIRST_SVC[$s]=$t; }; done
      printf '%-5s %s | %s\n' "${t}s" "$line" "${bad:-all ok}"; sleep 2
    done
    echo; echo "-- healing"; heal; sleep 5
    echo; echo "== result"
    echo "root cause (injected): $SVC ($FAULT)"
    echo "predicted blast radius: $(radius "$SVC" | awk '{printf "%s(hop%s) ",$2,$1}')"
    echo "gateway routes that failed:"; for p in "${PROBES[@]}"; do IFS='|' read -r n s _ <<<"$p"; [ -n "${FIRST_ROUTE[$n]:-}" ] && echo "  /api/$n (served by $s)  first failure at t=${FIRST_ROUTE[$n]}s"; done
    [ ${#FIRST_ROUTE[@]} -eq 0 ] && echo "  none -- the fault was absorbed (retries, caching or a fallback)"
    echo "predicted-but-healthy routes:"; for p in "${PROBES[@]}"; do IFS='|' read -r n s _ <<<"$p"
      if { [ "$s" = "$SVC" ] || radius "$SVC" | awk '{print $2}' | grep -qx "$s"; } && [ -z "${FIRST_ROUTE[$n]:-}" ]; then echo "  /api/$n"; fi; done
    echo "unexpected failures (route failed, service not downstream of the root):"; for p in "${PROBES[@]}"; do IFS='|' read -r n s _ <<<"$p"
      if [ -n "${FIRST_ROUTE[$n]:-}" ] && [ "$s" != "$SVC" ] && ! radius "$SVC" | awk '{print $2}' | grep -qx "$s"; then echo "  /api/$n"; fi; done
    echo; echo "What an RCA tool should say: root cause = $SVC; the symptom (errors/latency) shows first at $ENTRY, which is only the victim."
    echo "saved: $OUT";;
  *) echo "commands: list | predict <svc> | inject <svc> <fault> | heal [svc] | run <svc> <fault> [secs]" >&2; exit 2;;
esac
