# How these subjects fit the Microservice Mapper

## 1. What the mapper can and cannot see (and what each subject therefore provides)

From the mapper's README, wiki and source (`server/`, `remote-collector/`):

| Mapper capability | Mechanism | What the subjects supply |
|---|---|---|
| Declared topology | reads the compose file named in the container label `com.docker.compose.project.config_files` and parses `depends_on` | accurate, complete `depends_on` in the baseline; scenarios that deliberately break declared == observed |
| Observed topology | per-container `/proc/<pid>/net/tcp` sampling every ~5 s | real TCP between containers (HTTP keep-alive, Postgres pools, Redis, NATS) |
| Container telemetry | `docker stats`: CPU, memory, network; `docker ps/inspect`: state, restart count | memory limits on every service, CPU limits where relevant, `restart: always` so crash loops are visible as exits/restarts |
| Tier 1: gateway logs | JSON access-log lines with `upstream_addr`, `status`, `upstream_response_time` read from the *gateway* container | nginx edge in both systems with exactly that log format |
| Tier 2: Prometheus (opt-in) | queries the target's own Prometheus for `http_server_request_duration_seconds_*` | `--profile observability` adds Prometheus; each service exposes `/metrics` with that histogram; job name == service name |
| Incident rules | z-score (2.5/3/4), absolute 70/85 %, flat-baseline jump rule | scenarios built to pass *and* to evade each rule (e.g. `sf-09` plateaus at 25 % CPU; `ll-01` has no CPU signal at all) |
| RCA | temporal precedence, exited/critical status, observed dependency, blast radius | scenarios with a clear origin, an ambiguous origin (`sf-04`, `sf-08`), and no single origin (`ll-01`, a cycle) |
| ML findings | per-service anomaly models on metric history | slow ramps (`sf-03`), sudden jumps (`ll-05`) |

**Cannot see (by design):** request content, query text, lock waits, cache hit rates, application error counters, per-request traces,
business correctness. Each `scenario.yaml` lists the specific `mapper_blind_spots` for that failure, so a miss is classified as
"expected limit" rather than "bug".

## 2. Why these failures

A test subject for an RCA tool must satisfy three conditions:

1. **The failure is not a code bug.** If a developer could have found it by reading the diff, the mapper adds nothing. Every
   scenario here is a *latent condition* that passes code review, unit tests and staging: `0` read as "unlimited", a cache sized
   for 300 products, a pool size that is fine until the sum of pools is computed, two services each correct in isolation.
2. **The ground truth is known.** Because the condition is injected by config/data/topology, the true root cause is a fact, not
   an opinion -- so detection and RCA can be scored.
3. **The signature is realistic.** Each scenario produces the footprint real incidents produce: an outage with a healthy-looking
   origin (`sf-04`), a degraded service whose CPU is *low* because it is waiting (`sf-01`'s `orders`, `ll-01`), a failure with a clean
   front door (`sf-10`, `ll-05`), a dependency that exists only in code (`sf-06`, `ll-06`), a declared edge nobody uses (`sf-07`).

The developer-time argument, concretely: for each scenario the "typical triage path" is the one a team follows from the symptom
(`checkout 502s` -> gateway -> orders -> payments ...). The mapper's value is collapsing that to one signal: which node's resources
moved first, which declared edge never lit up, which observed edge nobody declared.

## 3. Attaching a subject to the mapper

1. Run the subject on a Linux Docker host the mapper can SSH into (an EC2 `t3.large` or better runs either system; the database
   scenarios want the DB containers to get real CPU).
2. `make scenario SCEN=<id>` inside the project (or `lab/up.sh <subject> <scenario>`) -- **do not hand-run `docker compose -f a -f b`.** It renders one effective compose file because
   the mapper cats the path in `com.docker.compose.project.config_files` as a single path; with two `-f` files Docker comma-joins them
   and the mapper silently loses every declared edge (see section 5).
3. In the mapper UI: **+ Add Project**, Target ID `shopflow` or `ledgerline`, host IP, SSH user/key. The only public port is the
   gateway (`:8080` ShopFlow, `:8081` LedgerLine); everything else is on the internal Docker network, as in production.
4. Generate traffic from outside the host: `node lab/loadgen.mjs <subject> --base http://<host>:<port> ...` (or the mapper's own
   traffic generator against the gateway; paths are in each subject's README).
5. **Tier 2 (optional):** `make obs-up` starts Prometheus (`127.0.0.1:9090`, job name == service name, `http_server_request_duration_seconds` histograms) and, in the mapper's `data/remote_config.json` for that target:
   `"telemetrySources": { "prometheus": { "enabled": true } }`. Prometheus is where the mapper queries it (over SSH).
6. Score the run: `node lab/check-scenario.mjs --scenario <subject>/scenarios/<id> --target <targetId> --mapper http://localhost:3001`.

**Always run the baseline first and for long enough to fill the mapper's history.** The incident rules need >= 3 samples and the
ML path needs far more; a scenario injected into a cold mapper tests the cold start, not the detection.

## 4. Detection coverage by scenario (what each one exercises)

`S` = strong signal expected, `P` = partial, `-` = not visible to that capability. "Topology" = declared-vs-observed edges.

| Scenario | Resource rules | Topology | Tier 1 (gateway) | RCA origin | Notes |
|---|---|---|---|---|---|
| sf-01 missing index | S (orders-db CPU) | P | S | clear (orders-db) | `orders` CPU stays low |
| sf-02 cache thrash | P (z-score only) | P | - | ambiguous | tests sensitivity; no outage |
| sf-03 unbounded cache | S (memory ramp, exit) | - | S (502 bursts) | clear (cart) | ML trend should lead rules |
| sf-04 retry storm | S (payments/orders) | S (edge volume) | S | origin is healthy (PSP) | hardest RCA case |
| sf-05 secret rotation | S (exited) | S (declared, not observed) | S | clear (orders) | `orders-db` is healthy |
| sf-06 shadow dependency | - | S (observed, undeclared) | - | n/a | topology finding, no incident |
| sf-07 dead dependency | - | S (declared, not observed) | - | n/a | topology finding, no incident |
| sf-08 noisy neighbour | S (catalog-db CPU) | P (edge volume) | S | ambiguous client | shared Postgres |
| sf-09 CPU throttle | P (flat 25 % ceiling) | - | S | clear (catalog) | evades 70/85 % rules |
| sf-10 poison message | S (notifier, event-bus) | S (edge volume) | S (absence of errors) | clear (notifier) | silent degradation |
| sf-11 wrong hostname | - | S (declared, not observed) | - | n/a | fail-open, no errors |
| ll-01 pool-starvation cycle | - (CPU idle) | S (cycle, undeclared back-edge) | S | none (cycle) | no resource metric moves |
| ll-02 provider outage | - | S (edge goes quiet) | S | clear (fx-provider) | breaker hides the dependency |
| ll-03 hot row | P | P | S | ledger-db | waiting, not working |
| ll-04 connection budget | - | S (two clients, one limit) | P | ledger-db | exhaustion reproduced; failover flip not |
| ll-05 batch OOM | S (exit/restart) | - | S (clean front door) | clear (statements-worker) | 4 s spike can fall between samples |
| ll-06 shadow dependency | - | S (observed, undeclared) | - | n/a | topology finding |

## 5. Things the subjects revealed about the mapper (worth acting on)

Found while building and measuring, not hypothetical:

1. **Multi-file compose projects lose all declared edges.** `DiscoveryEngine.discoverComposeDependencies` runs `cat` on the whole
   `com.docker.compose.project.config_files` label value. With `-f a.yml -f b.yml` that value is `a.yml,b.yml`, which is not a file, so
   discovery adds a warning and zero declared edges. Production Compose setups with an override file are common. The Makefile and `lab/up.sh`
   avoid it here; the mapper should split the label on `,`.
2. **A leaf root cause has an empty propagation path.** Edges point caller -> callee and `RCAEngine`'s propagation BFS follows
   outgoing edges from the root. Probing the real `RCAEngine` with gateway -> orders -> orders-db, all three failing and the database
   anomalous first: it ranks `orders-db` first (score 0.85 if `critical`), but `propagationPath` is just `["orders-db"]` -- it never
   reaches `orders` or `api-gateway`. The same direction convention means the "downstream blast radius" factor (+0.15) credits the
   *callers* of a failing node, not the node that broke them.
3. **The margin is thin when the origin is only `degraded`.** In the same probe with `orders-db` degraded instead of critical the
   scores are `orders-db` 0.65 vs `orders` 0.60. A saturated-but-alive database (`sf-01`, `sf-08`) is exactly this case.

None of these were changed here; the scenarios' `expect` blocks are written to the *intended* behaviour, so they will pin whichever
of these the mapper fixes.

## 6. What this will not tell you

* A passing `check-scenario` run says the mapper noticed the condition, not that its explanation helped a human. Record the RCA
  text for each run and judge it against the `ground_truth` and `fix` fields.
* Business-logic faults (wrong totals, double charges, stale prices) have no resource or topology footprint. They are out of scope for
  this kind of tool, and this repo deliberately contains none.
* Local numbers (`measured_locally`) come from a multi-core development machine with no cgroup limits. On a constrained container the
  same mechanisms get worse faster; treat them as lower bounds on severity, not as targets.
