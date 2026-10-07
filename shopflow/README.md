# ShopFlow -- online retail

A small but realistic retail backend: browse, cart, checkout, order history, confirmation e-mail.

```
                      internet
                         |  :8080
                  +--------------+      JSON access log (upstream_addr, status, upstream_response_time)
                  | api-gateway  |      nginx
                  +--+---+----+--+
          /api/catalog | /api/cart | /api/orders, /api/checkout
              +--------+   +-----+    +---------------------------+
              v            v          v                           |
        +----------+  +--------+  +--------+  reserve  +-----------+   +-----------+
        | catalog  |<-| cart   |  | orders |---------->| inventory |   | recommend.|  (optional)
        +--+----+--+  +---+----+  +-+-+-+-++           +-----+-----+   +-----------+
           |    |         |         | | | |  charge          |
   +-------+  +-+------+  |   +-----+ | | +-----> +----------+--------+
   v          v        v  v   v       | |         | payments |
catalog-  catalog-   cart-    orders-  | |         +----+-----+
 cache      db       store      db     | |              v
 (redis)  (postgres)(redis)  (postgres)| |        +-------------+
                       ^  also used by | |        | psp-sandbox |  third party (not ours)
                       |  inventory    | |        +-------------+
                       +---------------+ | order.placed
                                         v
                                   +-----------+   consume   +----------+
                                   | event-bus |------------>| notifier |--> (GET orders, optionally catalog)
                                   |   (NATS)  |             +----------+
                                   +-----------+
```

| Service | Role | Image / runtime | Notable settings (env) |
|---|---|---|---|
| api-gateway | edge routing, access log | nginx 1.27 | `GATEWAY_READ_TIMEOUT` (10 s); resolves upstreams per request so it stays up while a backend is down |
| catalog | product reads, cache-aside, `/export` for merchandising | node 22 | `CACHE_TTL_S` + jitter, `CATALOG_DB_POOL_MAX`, `MAX_PAGE`, `RECS_ENABLED` |
| catalog-db | Postgres 16: `catalog` **and** `inventory` databases (shared instance) | postgres | `max_connections=100`; 5,000 products seeded |
| catalog-cache | Redis, LRU | redis 7 | `maxmemory 64mb` |
| cart | carts in Redis, price validation against catalog, in-process recent-views | node 22 | `RECENT_MAX_ENTRIES`, `PRICE_VALIDATION_FAIL_OPEN`, `CATALOG_TIMEOUT_MS` |
| cart-store | Redis with AOF | redis 7 | `noeviction` |
| inventory | idempotent stock reservations (transactional) | node 22 | `INVENTORY_DB_POOL_MAX` |
| payments | charges via PSP with idempotency keys | node 22 | `PSP_RETRY_MAX`, `PSP_RETRY_BACKOFF_MS`, `PSP_TIMEOUT_MS` |
| psp-sandbox | simulated card processor: latency, 2 % declines, optional per-second quota | node 22 | `PSP_RATE_LIMIT_RPS`, `PSP_LATENCY_MS` |
| orders | checkout saga (cart -> reserve -> charge -> persist -> publish), history | node 22 | `ORDERS_DB_POOL_MAX`, per-hop timeouts, `PAYMENTS_RETRY_*`, `ORDER_EVENT_SCHEMA` |
| orders-db | Postgres 16, orders table (PK only; history by `user_id`) | postgres | `SEED_ORDERS` (5,000 by default) |
| event-bus | NATS JetStream, stream `ORDERS` | nats 2.10 | durable pull consumer |
| notifier | confirmation e-mail consumer (CPU-bound render) | node 22 | `NOTIFIER_MAX_DELIVER/MAX_ACK_PENDING/NAK_DELAY_MS`, `NOTIFIER_ENRICH_FROM_CATALOG` |

## Request flows

* **Browse:** gateway -> catalog -> (cache hit) | (cache miss -> catalog-db, then cache with jittered TTL).
* **Add to cart:** gateway -> cart -> catalog (price validation; falls open to the client price if catalog is unreachable) -> cart-store.
* **Checkout:** gateway -> orders -> cart (read) -> inventory (reserve, idempotent per order id) -> payments -> PSP (idempotency key) ->
  orders-db (insert) -> cart (clear) -> event-bus (`order.placed`). A failed payment releases the reservation.
* **Confirmation:** notifier consumes `order.placed`, fetches the order, renders and "sends" the e-mail. Customers never wait on it.

## Design properties worth knowing (they decide what the scenarios can and cannot do)

* **Baseline == declared:** `depends_on` matches the real call graph exactly, including `condition: service_healthy` for databases.
* **Failure behaviour is deliberate:** payments/psp errors become 402/502 (never 500), inventory conflicts 409, cart *fails open*
  on price validation, event publish is fire-and-forget, DB startup is retried 30x then exits non-zero.
* **Sizing:** every container has a memory limit; databases are small enough to hit limits with modest data.
* **Idempotent writes:** reservations are keyed by order id, PSP charges by `Idempotency-Key`, so retries are safe -- which is why the
  retry storm in `sf-04` is a *load* problem, not a correctness problem.

## Traffic

`node lab/loadgen.mjs shopflow` (journeys in `loadgen/journeys.js`: browse 60 / cart 25 / checkout 15). For the mapper's own
traffic generator, the public paths are:

```
GET  /api/catalog/products?category=shoes&limit=20     GET  /api/catalog/products/{id}
POST /api/cart/{userId}/items   {"productId":1,"qty":1,"priceCents":1000}     GET /api/cart/{userId}
POST /api/checkout   {"userId":"u1","email":"u1@example.test"}                GET /api/orders?userId=u1
```

## Run and test it

```bash
make test            # build, start all containers, run the API tests (tests/api.test.mjs)
make load            # traffic through the gateway
make ps | make logs SVC=<service>
make scenario SCEN=<id>      # sf-00-baseline is the control group; `make scenarios` lists the rest
make down
lab/local-stack.sh shopflow up    # no Docker: plain processes (needs node, postgres, redis, nats-server)
```

`docker-compose.expose.yml` (used by `make`) publishes every service on 127.0.0.1 so each API can be called directly; the baseline file
itself exposes only the gateway. The API tests (`tests/api.test.mjs`) are the executable description of every endpoint.
