#!/usr/bin/env bash
# Build every image of a subject with plain `docker build` (so an optional CA bundle can be passed as a build secret).
#   lab/build.sh shopflow            BUILD_CA_BUNDLE=/path/ca.crt lab/build.sh shopflow   (TLS-intercepting proxies)
# Normal environments do not need this: `docker compose up --build` works unchanged.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; S="${1:?subject}"
SECRET=(); [ -n "${BUILD_CA_BUNDLE:-}" ] && SECRET=(--secret "id=ca,src=$BUILD_CA_BUNDLE")
for d in "$ROOT/$S"/services/*/; do
  n="$(basename "$d")"
  echo "== building $S/$n"
  docker build -q "${SECRET[@]}" -f "$d/Dockerfile" -t "$S/$n:dev" "$ROOT/$S" >/dev/null
done
echo "built: $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$S/" | tr '\n' ' ')"
