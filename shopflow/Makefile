# shopflow -- self-contained: everything needed to build, run and test it lives in this directory.
#   make up                 build images and start the healthy baseline            (gateway on :8080)
#   make test               start (if needed) and run the API tests against every service
#   make load               generate traffic (20 concurrent users, 60 s)
#   make scenario SCEN=sf-01-missing-index     start with one production condition applied
#   make bench              app + always-on traffic + observability (Grafana :3000, Prometheus :9090, Loki, docker-exporter; localhost only)
#   make obs-up | obs-down  observability only (app must be running)
#   make urls               where to look
#   make down               stop and delete volumes (databases re-seed on next start)
#   make ps | logs SVC=<name> | scenarios
#
# Behind a TLS-intercepting proxy, build with:  make up BUILD_CA_BUNDLE=/path/to/ca.crt
.DEFAULT_GOAL := up
COMPOSE      ?= docker compose -f docker-compose.yml
EXPOSE_FILES  = -f docker-compose.expose.yml
SCEN         ?= sf-00-baseline
RENDERED      = .rendered/docker-compose.yml
BUILD_CA_BUNDLE ?=
PROFILES ?=
export COMPOSE_PROFILES = $(PROFILES)
GRAFANA_PASSWORD ?= bench
export GRAFANA_PASSWORD

# images: plain compose build normally; docker build with a CA secret when BUILD_CA_BUNDLE is set
define build
	@if [ -n "$(BUILD_CA_BUNDLE)" ]; then \
	  for d in services/*/; do n=$$(basename $$d); docker build -q --secret id=ca,src=$(BUILD_CA_BUNDLE) -f $$d/Dockerfile -t shopflow/$$n:dev . >/dev/null || exit 1; done; \
	  docker build -q --secret id=ca,src=$(BUILD_CA_BUNDLE) -f loadgen/Dockerfile -t shopflow/traffic:dev . >/dev/null; \
	else $(1) build; fi
endef

# Render ONE effective compose file (baseline + scenario + test ports). The mapper reads declared dependencies from the file named in
# the container label com.docker.compose.project.config_files; several -f files would be comma-joined there and silently break that.
render:
	@mkdir -p .rendered
	@docker compose -f docker-compose.yml -f scenarios/$(SCEN)/compose.override.yml $(EXPOSE_FILES) config > $(RENDERED)

up: render
	$(call build,docker compose -f $(RENDERED))
	docker compose -f $(RENDERED) up -d --no-build
	@curl -s -m 3 -u admin:$(GRAFANA_PASSWORD) -X POST http://localhost:3000/api/annotations -H 'Content-Type: application/json' -d '{"tags":["scenario"],"text":"scenario applied: $(SCEN)"}' >/dev/null 2>&1 || true
	@echo "shopflow up: http://localhost:8080  (scenario: $(SCEN))"

# keeps the always-on traffic container part of the project when a scenario is applied (no 'orphan' warning)
scenario:
	$(MAKE) up PROFILES=traffic

wait:
	@for i in $$(seq 1 90); do docker compose -f $(RENDERED) ps --format '{{.Status}}' | grep -qE 'starting|unhealthy' || break; sleep 2; done; sleep 3

test: up wait
	npm ci --silent
	node --test tests/api.test.mjs

load:
	node loadgen/loadgen.mjs --concurrency 20 --duration 60

ps:
	docker compose -f $(RENDERED) ps

logs:
	docker compose -f $(RENDERED) logs --tail 80 $(SVC)

down: obs-down
	-COMPOSE_PROFILES=traffic docker compose -f $(RENDERED) down -v --remove-orphans

scenarios:
	@ls scenarios

# Observability is a separate compose project (shopflow-obs) joined to the app network -- see docker-compose.obs.yml
obs-up:
	docker compose -f docker-compose.obs.yml up -d
	@echo "Grafana http://localhost:3000 (admin / $(GRAFANA_PASSWORD), anonymous viewing on)   Prometheus http://localhost:9090"

obs-down:
	-docker compose -f docker-compose.obs.yml down -v --remove-orphans

bench:
	$(MAKE) up PROFILES=traffic
	$(MAKE) obs-up

urls:
	@echo "app gateway : http://localhost:8080"
	@echo "Grafana     : http://localhost:3000  (dashboard: shopflow test bench)    Prometheus: http://localhost:9090"
	@echo "from your laptop: ssh -L 3000:localhost:3000 -L 9090:localhost:9090 <user>@<ec2-host>"

.PHONY: render up scenario wait test load ps logs down scenarios obs-up obs-down bench urls
