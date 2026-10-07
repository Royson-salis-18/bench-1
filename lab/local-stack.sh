#!/usr/bin/env bash
# Run a subject WITHOUT Docker (for development, CI and verification on machines with no daemon).
# Needs: node >= 20, postgres 14+ server binaries, redis-server, nats-server on PATH or NATS_SERVER.
#   lab/local-stack.sh shopflow up [scenario-env-file]   |   status   |   down   |   logs <service>
# Scenario env files hold lines like:  orders:PAYMENTS_RETRY_MAX=5   or   infra:SEED_ORDERS=2000000
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBJECT="${1:?subject: shopflow|ledgerline}"; CMD="${2:-status}"; SCEN="${3:-}"
RUN="${LAB_RUN_DIR:-/tmp/lab-$SUBJECT}"; mkdir -p "$RUN"; chmod 777 "$RUN"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
NATS="${NATS_SERVER:-$(command -v nats-server || true)}"
pg_user() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
scen_env() { # scen_env <service> -> KEY=VAL pairs for that service from the scenario file
  [ -n "$SCEN" ] && grep -E "^$1:" "$SCEN" | sed "s/^$1://" | tr '\n' ' ' || true; }

start_pg() { # name port seed-script-dir
  local name=$1 port=$2 data="$RUN/pg-$1"
  if [ ! -d "$data" ]; then
    mkdir -p "$data"; [ "$(id -u)" = 0 ] && chown postgres "$data"
    pg_user "$PGBIN/initdb -D $data -U app --auth=trust >/dev/null"
  fi
  pg_user "$PGBIN/pg_ctl -D $data -o '-p $port -k $RUN -c max_connections=${PG_MAX_CONNECTIONS:-100} -c listen_addresses=127.0.0.1' -l $RUN/pg-$name.log -w start >/dev/null"
}
seed() { # seed <port> <db> <script> [env...]
  local port=$1 db=$2 script=$3; shift 3
  if ! "$PGBIN/psql" -h 127.0.0.1 -p "$port" -U app -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
    "$PGBIN/psql" -h 127.0.0.1 -p "$port" -U app -d postgres -qc "create database $db"
    env POSTGRES_USER=app POSTGRES_DB=$db "$@" PGHOST=127.0.0.1 PGPORT=$port bash "$script" >/dev/null
  fi
}
spawn() { # spawn <name> <env...> -- <cmd...>
  local name=$1; shift; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  ( cd "$ROOT"; env "${envs[@]}" SERVICE_NAME="$name" nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null & echo $! >"$RUN/$name.pid" )
}
stop_all() {
  for f in "$RUN"/*.pid; do [ -f "$f" ] || continue; kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  for d in "$RUN"/pg-*/; do [ -d "$d" ] || continue; pg_user "$PGBIN/pg_ctl -D $d -m fast -w stop >/dev/null 2>&1" || true; done
  sleep 1
}
case "$CMD" in
  down) stop_all; exit 0;;
  status) for f in "$RUN"/*.pid; do [ -f "$f" ] && printf '%-16s pid %s %s\n' "$(basename "$f" .pid)" "$(cat "$f")" "$(kill -0 "$(cat "$f")" 2>/dev/null && echo up || echo DEAD)"; done; exit 0;;
  logs) tail -n 40 "$RUN/${3:?service}.log"; exit 0;;
  up) ;;
  *) echo "unknown command" >&2; exit 2;;
esac
source "$ROOT/lab/local/$SUBJECT.sh"
