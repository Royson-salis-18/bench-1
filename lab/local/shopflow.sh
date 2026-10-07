# sourced by local-stack.sh -- brings up ShopFlow on localhost
INFRA="$(scen_env infra)"; if [ -n "${INFRA// /}" ]; then export $INFRA; fi
start_pg catalog 5441; start_pg orders 5442
seed 5441 catalog "$ROOT/shopflow/db/catalog-db/10-init.sh" SEED_PRODUCTS="${SEED_PRODUCTS:-5000}"
seed 5442 orders  "$ROOT/shopflow/db/orders-db/10-init.sh"  SEED_ORDERS="${SEED_ORDERS:-5000}"
redis-server --port 6441 --maxmemory "${CACHE_MAXMEM:-64mb}" --maxmemory-policy allkeys-lru --save "" --dir "$RUN" --daemonize yes --pidfile "$RUN/redis-cache.pid" --logfile "$RUN/redis-cache.log" >/dev/null
redis-server --port 6442 --maxmemory 96mb --maxmemory-policy noeviction --save "" --dir "$RUN" --daemonize yes --pidfile "$RUN/redis-cart.pid" --logfile "$RUN/redis-cart.log" >/dev/null
spawn event-bus -- "$NATS" -js -sd "$RUN/nats" -p 4241
sleep 1
B=shopflow/services; N="node"
spawn psp-sandbox PORT=4000 $(scen_env psp-sandbox) -- $N $B/psp-sandbox/index.js
spawn recommendations PORT=3008 -- $N $B/recommendations/index.js
spawn catalog PORT=3001 CATALOG_DB_HOST=127.0.0.1 CATALOG_DB_PORT=5441 CACHE_HOST=127.0.0.1 CACHE_PORT=6441 RECOMMENDATIONS_URL=http://127.0.0.1:3008 $(scen_env catalog) -- $N $B/catalog/index.js
spawn inventory PORT=3003 INVENTORY_DB_HOST=127.0.0.1 INVENTORY_DB_PORT=5441 $(scen_env inventory) -- $N $B/inventory/index.js
spawn cart PORT=3002 CART_STORE_HOST=127.0.0.1 CART_STORE_PORT=6442 CATALOG_URL=http://127.0.0.1:3001 $(scen_env cart) -- $N $B/cart/index.js
spawn payments PORT=3004 PSP_URL=http://127.0.0.1:4000 $(scen_env payments) -- $N $B/payments/index.js
spawn orders PORT=3005 ORDERS_DB_HOST=127.0.0.1 ORDERS_DB_PORT=5442 NATS_URL=nats://127.0.0.1:4241 CART_URL=http://127.0.0.1:3002 INVENTORY_URL=http://127.0.0.1:3003 PAYMENTS_URL=http://127.0.0.1:3004 $(scen_env orders) -- $N $B/orders/index.js
spawn notifier PORT=3006 NATS_URL=nats://127.0.0.1:4241 ORDERS_URL=http://127.0.0.1:3005 CATALOG_URL=http://127.0.0.1:3001 $(scen_env notifier) -- $N $B/notifier/index.js
ROUTES='[{"prefix":"/api/catalog/","rewrite":["^/api/catalog/","/"],"upstream":"http://127.0.0.1:3001"},{"prefix":"/api/cart/","rewrite":["^/api/cart/","/carts/"],"upstream":"http://127.0.0.1:3002"},{"prefix":"/api/orders","rewrite":["^/api/orders","/orders"],"upstream":"http://127.0.0.1:3005"},{"prefix":"/api/checkout","rewrite":["^/api/checkout","/checkout"],"upstream":"http://127.0.0.1:3005"}]'
spawn api-gateway PORT=8080 ROUTES="$ROUTES" ACCESS_LOG="$RUN/gateway-access.log" -- node lab/local/gateway-shim.js
for i in $(seq 1 40); do curl -sf localhost:8080/api/catalog/products?limit=1 >/dev/null && break; sleep 0.5; done
echo "shopflow up on :8080 (logs in $RUN)"
