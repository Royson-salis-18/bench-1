#!/usr/bin/env bash
# Stop a subject and delete its volumes (databases re-seed on next start, which is what resets a scenario).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; SUBJECT="${1:?subject}"
F="$ROOT/$SUBJECT/.rendered/docker-compose.yml"
[ -f "$F" ] || { echo "nothing rendered for $SUBJECT" >&2; exit 0; }
COMPOSE_PROFILES=traffic docker compose -f "$F" down -v --remove-orphans
