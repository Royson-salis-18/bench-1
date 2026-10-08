# bench-1 wiki: ShopFlow

An e-commerce microservice system built as a **test subject for the Microservice Mapper / RCA lab**. The code is correct; the failures come from production conditions (configuration drift, data volume, sizing, topology, third parties), so what you detect is what a real incident looks like.

## Contents
1. [Architecture](#architecture) - 2. [Repository map](#repository-map) - 3. [Run it](#run-it) - 4. [Use it as a customer](#use-it-as-a-customer) - 5. [Break it](#break-it) - 6. [Observe it](#observe-it) - 7. [Connect the mapper](#connect-the-mapper) - 8. [Troubleshooting](#troubleshooting) - 9. [Known limits](#known-limits)

## Architecture
```
 browser / loadgen -> api-gateway (nginx :8080, JSON access log with upstream_addr, also serves the storefront UI)
   /api/catalog -> catalog :3001 -> catalog-db (Postgres), catalog-cache (Redis, cache-aside)
   /api/cart    -> cart :3002    -> cart-store (Redis), catalog (price check)
   /api/orders, /api/checkout -> orders :3005 (saga) -> cart, inventory, payments, orders-db (Postgres), event-bus (NATS JetStream)
   inventory -> catalog-db (shared Postgres instance)        payments -> psp-sandbox (third-party stand-in)
   notifier <- event-bus (order.placed), calls orders to render the e-mail
```
| Service | Role | Backing |
|---|---|---|
| api-gateway | edge routing, storefront, Tier-1 access log | nginx |
| catalog | products, search | Postgres + Redis cache-aside |
| cart | per-user carts | Redis |
| inventory | stock reservation | shares the catalog Postgres instance |
| orders | checkout saga: cart -> reserve stock -> charge -> persist -> publish | Postgres, NATS |
| payments | charge via the PSP | psp-sandbox (throttles/fails on demand) |
| notifier | confirmation e-mails | NATS JetStream consumer (NAK + redelivery, max 5) |

Every service exposes Prometheus metrics (`http_server_request_duration_seconds`, label `job`), health endpoints and structured JSON logs.

## Repository map
| Path | What |
|---|---|
| `shopflow/` | the application: `services/*`, `lib/` (shared HTTP, retry, breaker, NATS helpers), `nginx/`, `storefront/index.html`, `loadgen/` (journeys + organic sessions), `db/`, `tests/` |
| `shopflow/scenarios/*/scenario.yaml` | 12 production conditions, each with ground truth, the load that triggers it, expected mapper signals and the fix |
| `shopflow/docker-compose.yml` / `.obs.yml` | the app / the observability project (Prometheus, Grafana, Loki, Promtail, docker-exporter, grafana-viewer) |
| `shopflow/Makefile` | `up test bench scenario traffic-off traffic-on obs-up obs-down down urls scenarios` |
| `lab/` | `bench-scenario.sh` (one-command scenario run + report), `chaos.sh` (fault injection on any service), `cascade.sh` (staged orders cascade), `docker-exporter.js`, validators |
| `bootstrap/ec2-setup.sh` | one-command EC2 setup (Ubuntu / Amazon Linux) |
| `docs/` | this wiki, COMMANDS, CHAOS, SCENARIO-CATALOG, HOW-IT-FITS-THE-MAPPER |

## Run it
EC2: Ubuntu 24.04, `c7i-flex.large`, open TCP 22 and 8080 from your IP, then on the instance:
```
curl -fsSL https://raw.githubusercontent.com/Royson-salis-18/bench-1/main/bootstrap/ec2-setup.sh | bash
```
Locally (Docker): `cd shopflow && make bench` (add `BUILD_CA_BUNDLE=/path/ca.crt` behind a TLS-intercepting proxy). Full step-by-step and updating: [COMMANDS.md](COMMANDS.md).

## Use it as a customer
Open `http://<ip>:8080/`: browse, add to cart, check out, My orders. A live request log shows every call through the gateway; *Autopilot* browses for you. Background traffic is organic (visitor sessions, think times, popular products, returning users, day/night wave). `sudo make traffic-off` silences it so only your clicks count; `traffic-on` restores it.

## Break it
* **Production-condition scenarios** (12, e.g. missing index, cache thrash, retry storm, secret rotation, noisy neighbour, poison message): [SCENARIO-CATALOG.md](SCENARIO-CATALOG.md); run one with `lab/bench-scenario.sh shopflow sf-04-retry-storm`.
* **Fault injection on any service** (`stop pause cpu net crash flap`) with predicted blast radius vs observed: `lab/chaos.sh` - [CHAOS.md](CHAOS.md).
* **Organic cascade starting in orders** (brownout -> hang -> recovery, real load): `sudo lab/cascade.sh shopflow orders`. Measured: checkout 70 ms -> 1-3 s -> 504 at 10 s, notifier backlog grows to ~200+; catalog and cart stay healthy (the gateway isolates routes).

## Observe it
Grafana `:3000` (dashboard "test bench", 25 panels), Prometheus `:9090`, Loki through Grafana. All on `127.0.0.1` of the instance; tunnel with `ssh -L 3000:localhost:3000 -L 9090:localhost:9090 ubuntu@<ip>`. `grafana-viewer` keeps Grafana -> Prometheus/Loki connections alive so the mapper can see them.

## Connect the mapper
*Add Project*: Target ID `shopflow`, Host = instance IP, user `ubuntu`, your `.pem`. The mapper reads declared edges from `shopflow/.rendered/docker-compose.yml` (one merged file; multiple `-f` files break the compose label), observed edges from `/proc/net/tcp`, resources from `docker stats`, Tier 1 from the gateway log, Tier 2 from Prometheus. Details and findings about the mapper: [HOW-IT-FITS-THE-MAPPER.md](HOW-IT-FITS-THE-MAPPER.md).

## Troubleshooting
See the table in [COMMANDS.md](COMMANDS.md#10-common-problems). Most common: old clone on the instance (`git fetch --depth 1 origin main && git reset --hard FETCH_HEAD`), missing security-group rule for 8080, wrong key path.

## Known limits
Verified on Ubuntu 24.04 / c7i-flex.large and in a local Docker sandbox. Spring/Micrometer Tier 2 metrics need extra configuration (the separate ecom-lab). The traffic generator can make mapper edges red under heavy scenarios; use `traffic-off` for a clean signal.
