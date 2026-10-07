#!/usr/bin/env bash
# Bring a subject up with one scenario applied.
#   lab/up.sh shopflow sf-05-secret-rotation        # a scenario
#   lab/up.sh ledgerline ll-00-baseline             # the control group
#   PROFILES=traffic lab/up.sh shopflow sf-01-missing-index         # + always-on traffic generator   (monitoring: make -C shopflow obs-up)
#
# Why this renders ONE file instead of using `-f base -f override`:
# the mapper learns "declared" dependencies by reading the compose file named in the container label
# com.docker.compose.project.config_files. With two -f files Docker joins the paths with a comma, which the mapper
# then tries to `cat` as a single path -- so every declared edge silently disappears. A single rendered file avoids that.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBJECT="${1:?subject: shopflow|ledgerline}"; SCEN="${2:?scenario id, e.g. sf-00-baseline}"; shift 2
DIR="$ROOT/$SUBJECT"; OVR="$DIR/scenarios/$SCEN/compose.override.yml"
[ -f "$OVR" ] || { echo "no such scenario: $OVR" >&2; exit 2; }
mkdir -p "$DIR/.rendered"
[ -n "${PROFILES:-}" ] && export COMPOSE_PROFILES="$PROFILES"
FILES=(-f "$DIR/docker-compose.yml" -f "$OVR")
# EXPOSE=1 also publishes every internal service on 127.0.0.1 (for the API tests)
[ -n "${EXPOSE:-}" ] && FILES+=(-f "$DIR/docker-compose.expose.yml")
docker compose "${FILES[@]}" config > "$DIR/.rendered/docker-compose.yml"
echo "rendered $DIR/.rendered/docker-compose.yml  (scenario: $SCEN)"
BUILD_ARGS=(--build)
if [ -n "${BUILD_CA_BUNDLE:-}" ]; then "$ROOT/lab/build.sh" "$SUBJECT"; BUILD_ARGS=(--no-build); fi
docker compose -f "$DIR/.rendered/docker-compose.yml" up -d "${BUILD_ARGS[@]}" "$@"
echo "scenario spec : $DIR/scenarios/$SCEN/scenario.yaml"
echo "tear down     : lab/down.sh $SUBJECT"
