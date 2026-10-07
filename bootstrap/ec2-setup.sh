#!/usr/bin/env bash
# One-command setup of a test bench on a fresh Ubuntu/Debian or Amazon Linux EC2 instance.
#
#   curl -fsSL https://raw.githubusercontent.com/Royson-salis-18/bench-1/main/bootstrap/ec2-setup.sh | bash -s -- shopflow
#   (or:  git clone https://github.com/Royson-salis-18/bench-1 && cd bench-1 && bash bootstrap/ec2-setup.sh shopflow)
#
# What it does: installs Docker + git + make, adds swap on small instances, clones the repo, and runs `make bench` for the chosen project:
# the application containers + an always-on traffic generator + Prometheus/Grafana/Loki/Promtail/docker-exporter (all monitoring on localhost only).
# Only the application gateway (:8080 shopflow, :8081 ledgerline) is published on the network. Everything restarts on reboot (restart: always).
#
# Env: REPO_URL (default below), BRANCH, SUBJECT (or first arg), DRY_RUN=1 (print the commands, change nothing), GRAFANA_PASSWORD (default "bench").
# Run end to end on Ubuntu 24.04 (c7i-flex.large, ap-south-1): packages, Docker 29, build, app + traffic + monitoring all came up. Not yet run on Amazon Linux.
set -euo pipefail
SUBJECT="${1:-${SUBJECT:-shopflow}}"
REPO_URL="${REPO_URL:-https://github.com/Royson-salis-18/bench-1.git}"
BRANCH="${BRANCH:-main}"
DEST="${DEST:-$HOME/bench}"
run() { echo "+ $*"; [ -n "${DRY_RUN:-}" ] || eval "$*"; }
case "$SUBJECT" in shopflow) ;; *) echo "this repo contains only: shopflow" >&2; exit 2;; esac
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

echo "== 1/5 packages"
if command -v apt-get >/dev/null; then run "$SUDO apt-get update -y && $SUDO apt-get install -y git make curl ca-certificates"
elif command -v dnf >/dev/null; then run "$SUDO dnf install -y git make curl"
elif command -v yum >/dev/null; then run "$SUDO yum install -y git make curl"
else echo "unsupported OS (need apt, dnf or yum)" >&2; exit 1; fi

echo "== 2/5 docker"
if ! command -v docker >/dev/null; then run "curl -fsSL https://get.docker.com | $SUDO sh"; fi
run "$SUDO systemctl enable --now docker"
# the mapper SSHes in as this user and runs `docker ps/inspect/stats`, so the user must be in the docker group (takes effect on the next login)
[ "$(id -u)" = 0 ] || run "$SUDO usermod -aG docker $USER"
run "$SUDO docker compose version"

echo "== 3/5 swap (small instances: the whole bench needs ~0.65 GiB of containers)"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 4096)
if [ "$MEM_MB" -lt 3000 ] && ! swapon --show | grep -q .; then
  run "$SUDO fallocate -l 2G /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile && $SUDO swapon /swapfile && echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null"
fi

echo "== 4/5 source"
if [ -d "$DEST/.git" ]; then run "git -C '$DEST' fetch --depth 1 origin '$BRANCH' && git -C '$DEST' checkout -q FETCH_HEAD"
else run "git clone --depth 1 --branch '$BRANCH' '$REPO_URL' '$DEST'"; fi
ROOT="$DEST"; [ -d "$DEST/test-subjects" ] && ROOT="$DEST/test-subjects"

echo "== 5/5 start $SUBJECT (first run builds the images: a few minutes)"
run "cd '$ROOT' && $SUDO env GRAFANA_PASSWORD='${GRAFANA_PASSWORD:-bench}' make -C $SUBJECT bench"

# EC2 metadata needs a session token (IMDSv2) on current Ubuntu AMIs
IMDS_TOKEN=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
PUB=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
[ -n "$PUB" ] || PUB="<this-instance-public-ip>"
PORT=8080; [ "$SUBJECT" = ledgerline ] && PORT=8081
cat <<MSG

============================================================ $SUBJECT bench is up
 application gateway   http://$PUB:$PORT        (open this port in the security group; keep everything else closed)
 Grafana (localhost)   ssh -L 3000:localhost:3000 -L 9090:localhost:9090 ubuntu@$PUB   then http://localhost:3000  (admin / ${GRAFANA_PASSWORD:-bench})
 source on this box    $ROOT/$SUBJECT
 apply a scenario      cd $ROOT/$SUBJECT && sudo make scenario SCEN=<id>     (ids: make scenarios)
 stop                  cd $ROOT/$SUBJECT && sudo make down

 point the mapper at it:  + Add Project -> Target ID "$SUBJECT", Host $PUB, SSH user ubuntu (ec2-user on Amazon Linux), your .pem key.
 The compose file the mapper reads is $ROOT/$SUBJECT/.rendered/docker-compose.yml (one merged file, so declared dependencies are discovered).
=====================================================================================
MSG
