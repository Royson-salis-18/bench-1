# Chaos and cascading-failure testing (ShopFlow)

The gateway (`api-gateway`) is where users see every failure first, so a mapper's edge turns red there first. It is almost never the root cause.
`lab/chaos.sh` lets you break **any** service, watch the failure travel up the dependency graph, and compare it with a prediction, so you can check
that an RCA tool names the real root and that a cascade predictor gets the blast radius right.

```
cd ~/bench
lab/chaos.sh shopflow list                              # services and their dependencies
lab/chaos.sh shopflow predict catalog-db                     # predicted blast radius: who breaks if it breaks, hop by hop
lab/chaos.sh shopflow run catalog-db pause 40                 # inject, sample every ~3 s, print the timeline and prediction vs observed, heal
lab/chaos.sh shopflow inject psp-sandbox net                 # leave a fault on while you look at the mapper
lab/chaos.sh shopflow heal                              # undo every fault
```
Faults: `stop` (refused) - `pause` (accepts, never answers -> timeouts; the worst for cascades) - `cpu` (throttled to 5%, slow not dead) -
`net` (network partition) - `crash` (SIGKILL, restart policy revives it) - `flap` (frozen 4 s / running 4 s).
Each run is saved to `~/bench-results/chaos-*.txt`.

## Suggested cascade experiments
| Run | What you should see |
|---|---|
| `run catalog-db pause 40` | `/api/catalog` 5xx; cart and the orders list stay up (they do not touch it on the hot path) -- a *partial* cascade |
| `run psp-sandbox net 40` | payments cannot reach the PSP -> orders -> `/api/checkout` 502 -> the gateway; catalog/cart unaffected: a clean 3-hop chain |
| `run orders-db pause 40` | orders and checkout fail, notifier starves |
| `run event-bus stop 40` | order placement keeps working but notifications stop (async dependency) |
| `run cart-store crash 40` | cart errors, then recovers on its own when the restart policy revives it |
| `run catalog cpu 40` | latency rises first (slow, not dead), then timeouts at the gateway |

## The orders cascade (one command, ~3 minutes)

```
cd ~/bench
sudo lab/cascade.sh shopflow orders
```
A staged incident under real checkout-heavy customer load. Nothing is faked; each hop fails for its own reason:

| Phase | What is done | What spreads (measured on the bench) |
|---|---|---|
| baseline (25 s) | nothing | all routes healthy, checkout ~70 ms, notifier backlog 0 |
| brownout (45 s) | `orders` throttled to 5% CPU: still up, just slow | checkout 1-3 s and orders-list up to 1.5 s at the gateway; the notifier's call to orders times out, the message is NAK'd and redelivered, so the backlog grows steadily |
| hang (30 s) | `orders` frozen (accepts connections, never answers) | gateway returns **504 after 10 s** on `/api/orders` and `/api/checkout`; notifier retries burn their redelivery budget |
| recovery (60 s) | `orders` healed | orders answers again but latency stays high while the retry backlog drains onto it |

`catalog` and `cart` stay healthy: the gateway routes independently, so the blast radius is exactly what is connected to orders (the gateway routes it serves, and the notifier).
That is the *correct* answer a cascade predictor should give; a tool that also flags catalog/cart is over-predicting.
Phase lengths can be changed: `T_BASE=25 T_BROWN=45 T_HANG=30 T_RECOVER=60 lab/cascade.sh shopflow orders`. The report is saved to `~/bench-results/cascade-orders-*.txt`.
While it runs, watch the mapper (gateway edge red, orders the root) and Grafana (dashboard "test bench"; the notifier backlog panel climbs).

## How to read the report
* **predicted blast radius**: everything that transitively `depends_on` the broken service (from the rendered compose the mapper also reads). It is the *worst case*.
* **gateway routes that failed**: what users actually saw (HTTP 5xx or timeout), with the second the first failure appeared.
* **predicted-but-healthy**: declared dependents that did not fail (the call is not on that route's hot path, or a cache/fallback absorbed it). Real systems are
  usually *smaller* than the graph; a good predictor should learn which declared edges are really on the hot path.
* **unexpected failures**: a route failed although its service is not downstream of the root. Should be empty; if not, a hidden dependency exists.
* A good RCA answer is the injected service, not the entry point.

Tip: `make traffic-off` first for a clean signal, or leave the always-on traffic running to see real error ratios in Grafana (dashboard "test bench") while the fault is on.
