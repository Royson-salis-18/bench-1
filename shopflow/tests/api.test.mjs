// ShopFlow API tests: every endpoint of every service, plus the gateway routes and the async (event) path.
// Run against a live stack:  EXPOSE=1 ../lab/up.sh shopflow sf-00-baseline  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'nats';
import { GATEWAY, SVC, NATS_URL, get, post, del, req, uid, eventually } from './helpers.mjs';

// ---------------------------------------------------------------- platform endpoints
test('every service answers /healthz, /readyz and /metrics', async () => {
  for (const [name, base] of Object.entries(SVC)) {
    const h = await get(base, '/healthz');
    assert.equal(h.status, 200, `${name} /healthz`);
    assert.equal(h.json.status, 'ok');
    if (name !== 'notifier' || true) {
      const r = await get(base, '/readyz');
      assert.equal(r.status, 200, `${name} /readyz`);
      assert.equal(r.json.ready, true);
    }
    const m = await get(base, '/metrics');
    assert.equal(m.status, 200, `${name} /metrics`);
    assert.match(m.text, /process_resident_memory_bytes/, `${name} exposes process gauges`);
  }
});

test('gateway: /healthz, unknown route 404, request counted in service metrics', async () => {
  assert.equal((await get(GATEWAY, '/healthz')).status, 200);
  assert.equal((await get(GATEWAY, '/api/nothing-here')).status, 404);
  await get(GATEWAY, '/api/catalog/products?limit=1');
  const m = await get(SVC.catalog, '/metrics');
  assert.match(m.text, /http_server_request_duration_seconds_count\{[^}]*http_route="\/products"[^}]*http_response_status_code="200"\}/);
});

// ---------------------------------------------------------------- catalog
test('catalog: list, filter, limit, cap, detail, 404, export', async () => {
  let r = await get(SVC.catalog, '/products');
  assert.equal(r.status, 200); assert.equal(r.json.count, 50); assert.ok(r.json.items[0].sku);
  r = await get(SVC.catalog, '/products?limit=5');
  assert.equal(r.json.count, 5);
  r = await get(SVC.catalog, '/products?category=shoes&limit=20');
  assert.ok(r.json.count > 0 && r.json.items.every((p) => p.category === 'shoes'));
  r = await get(SVC.catalog, '/products?limit=100000');
  assert.ok(r.json.count <= 500, 'page size is capped');
  r = await get(SVC.catalog, '/products/1');
  assert.equal(r.status, 200); assert.equal(r.json.id, 1); assert.equal(r.json.sku, 'SKU-00001');
  r = await get(SVC.catalog, '/products/999999');
  assert.equal(r.status, 404);
  r = await get(SVC.catalog, '/export');
  assert.equal(r.status, 200); assert.equal(r.json.categories.length, 6);
});

test('catalog: cache-aside returns identical data on a repeat read', async () => {
  const a = await get(SVC.catalog, '/products?category=hats&limit=10');
  const b = await get(SVC.catalog, '/products?category=hats&limit=10');
  assert.deepEqual(a.json, b.json);
});

// ---------------------------------------------------------------- cart
test('cart: add, accumulate, price comes from catalog, totals, delete', async () => {
  const u = uid();
  let r = await post(SVC.cart, `/carts/${u}/items`, { productId: 1, qty: 2, priceCents: 1 });
  assert.equal(r.status, 201); assert.equal(r.json.qty, 2);
  const catalogPrice = (await get(SVC.catalog, '/products/1')).json.price_cents;
  assert.equal(r.json.priceCents, catalogPrice, 'client-supplied price is ignored when catalog is reachable');
  r = await post(SVC.cart, `/carts/${u}/items`, { productId: 1, qty: 1 });
  assert.equal(r.json.qty, 3);
  await post(SVC.cart, `/carts/${u}/items`, { productId: 2, qty: 1 });
  r = await get(SVC.cart, `/carts/${u}`);
  assert.equal(r.status, 200); assert.equal(r.json.items.length, 2);
  const p2 = (await get(SVC.catalog, '/products/2')).json.price_cents;
  assert.equal(r.json.totalCents, catalogPrice * 3 + p2);
  assert.equal((await del(SVC.cart, `/carts/${u}`)).status, 204);
  assert.equal((await get(SVC.cart, `/carts/${u}`)).json.items.length, 0);
});

test('cart: validation and unknown product', async () => {
  const u = uid();
  assert.equal((await post(SVC.cart, `/carts/${u}/items`, {})).status, 400);
  assert.equal((await post(SVC.cart, `/carts/${u}/items`, { productId: 1, qty: 0 })).status, 400);
  assert.equal((await post(SVC.cart, `/carts/${u}/items`, { productId: 999999, qty: 1 })).status, 404);
  const bad = await fetch(SVC.cart + `/carts/${u}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- inventory
test('inventory: stock, reserve (idempotent), insufficient, release', async () => {
  const sku = 'SKU-00077';
  const before = (await get(SVC.inventory, `/stock/${sku}`)).json;
  assert.equal((await get(SVC.inventory, '/stock/NOPE')).status, 404);
  const orderId = crypto.randomUUID();
  let r = await post(SVC.inventory, '/reserve', { orderId, items: [{ sku, qty: 3 }] });
  assert.equal(r.status, 201); assert.equal(r.json.reserved, true);
  let mid = (await get(SVC.inventory, `/stock/${sku}`)).json;
  assert.equal(mid.available, before.available - 3); assert.equal(mid.reserved, before.reserved + 3);
  r = await post(SVC.inventory, '/reserve', { orderId, items: [{ sku, qty: 3 }] });
  assert.equal(r.json.duplicate, true, 'same order id never double-reserves');
  assert.equal((await get(SVC.inventory, `/stock/${sku}`)).json.available, mid.available);
  r = await post(SVC.inventory, '/reserve', { orderId: crypto.randomUUID(), items: [{ sku, qty: 999999999 }] });
  assert.equal(r.status, 409);
  r = await post(SVC.inventory, '/release', { orderId });
  assert.equal(r.json.released, 1);
  assert.deepEqual((await get(SVC.inventory, `/stock/${sku}`)).json, before);
  assert.equal((await post(SVC.inventory, '/reserve', { items: [] })).status, 400);
});

// ---------------------------------------------------------------- psp-sandbox + payments
test('psp-sandbox: charge, idempotency key replays, validation', async () => {
  const key = uid('idem');
  const a = await post(SVC.psp, '/v1/charges', { amount: 1234 }, { 'idempotency-key': key });
  assert.equal(a.status, 200); assert.ok(['succeeded', 'declined'].includes(a.json.status));
  const b = await post(SVC.psp, '/v1/charges', { amount: 1234 }, { 'idempotency-key': key });
  assert.equal(b.json.id, a.json.id, 'same key -> same charge');
  assert.equal((await post(SVC.psp, '/v1/charges', { amount: 0 })).status, 400);
});

test('payments: charge, validation', async () => {
  assert.equal((await post(SVC.payments, '/charges', {})).status, 400);
  assert.equal((await post(SVC.payments, '/charges', { orderId: 'x', amountCents: -1 })).status, 400);
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) { // the sandbox declines ~2%; a 402 is a valid, documented outcome
    const r = await post(SVC.payments, '/charges', { orderId: uid('ord'), amountCents: 5000 });
    assert.ok([201, 402].includes(r.status), `unexpected ${r.status}`);
    if (r.status === 201) { ok = true; assert.equal(r.json.status, 'succeeded'); assert.ok(r.json.chargeId); }
  }
  assert.ok(ok, 'at least one charge succeeded');
});

// ---------------------------------------------------------------- checkout through the gateway (the whole saga)
async function checkoutViaGateway(userId, items) {
  for (const it of items) assert.equal((await post(GATEWAY, `/api/cart/${userId}/items`, it)).status, 201);
  for (let i = 0; i < 20; i++) { // retry past the sandbox's random declines
    const r = await post(GATEWAY, '/api/checkout', { userId, email: `${userId}@example.test` });
    if (r.status === 201) return r;
    assert.equal(r.status, 402, `checkout failed with ${r.status} ${r.text}`);
    for (const it of items) await post(GATEWAY, `/api/cart/${userId}/items`, it);
  }
  throw new Error('checkout never succeeded');
}

test('orders: validation and empty cart', async () => {
  assert.equal((await post(GATEWAY, '/api/checkout', {})).status, 400);
  assert.equal((await post(GATEWAY, '/api/checkout', { userId: uid() })).status, 409);
  assert.equal((await get(GATEWAY, '/api/orders')).status, 400);
  assert.equal((await get(SVC.orders, `/orders/${crypto.randomUUID()}`)).status, 404);
});

test('checkout end to end: cart -> inventory -> payments -> orders-db -> event', async () => {
  const u = uid('buyer'); const sku = 'SKU-00005';
  const stockBefore = (await get(SVC.inventory, `/stock/${sku}`)).json;
  const r = await checkoutViaGateway(u, [{ productId: 5, qty: 2 }]);
  assert.ok(r.json.orderId && r.json.totalCents > 0);

  const order = (await get(GATEWAY, `/api/orders/${r.json.orderId}`)).json;
  assert.equal(order.user_id, u); assert.equal(order.status, 'paid'); assert.equal(order.items[0].qty, 2);
  const hist = (await get(GATEWAY, `/api/orders?userId=${u}`)).json;
  assert.ok(hist.orders.some((o) => o.id === r.json.orderId), 'order appears in history');
  assert.equal((await get(GATEWAY, `/api/cart/${u}`)).json.items.length, 0, 'cart cleared after checkout');
  const stockAfter = (await get(SVC.inventory, `/stock/${sku}`)).json;
  assert.ok(stockAfter.available <= stockBefore.available - 2, 'stock was reserved'); // other tests may also reserve
});

test('async path: order.placed is consumed by the notifier (durable consumer drains)', async () => {
  await checkoutViaGateway(uid('async'), [{ productId: 9, qty: 1 }]);
  const nc = await connect({ servers: NATS_URL });
  try {
    const jsm = await nc.jetstreamManager();
    await eventually(async () => {
      const ci = await jsm.consumers.info('ORDERS', 'notifier');
      return ci.delivered.stream_seq >= 1 && ci.num_pending === 0 && ci.num_ack_pending === 0 && ci.ack_floor.stream_seq >= ci.delivered.stream_seq;
    }, { timeoutMs: 30000 });
  } finally { await nc.close(); }
});

// ---------------------------------------------------------------- gateway routing table
test('gateway routes every public path to the right service', async () => {
  const u = uid('gw');
  assert.equal((await get(GATEWAY, '/api/catalog/products?limit=1')).status, 200);
  assert.equal((await get(GATEWAY, '/api/catalog/products/1')).status, 200);
  assert.equal((await post(GATEWAY, `/api/cart/${u}/items`, { productId: 1, qty: 1 })).status, 201);
  assert.equal((await get(GATEWAY, `/api/cart/${u}`)).status, 200);
  assert.equal((await get(GATEWAY, `/api/orders?userId=${u}`)).status, 200);
  assert.equal((await post(GATEWAY, '/api/checkout', { userId: `${u}-empty` })).status, 409);
});

test('gateway access log is in the shape the mapper parses (needs the docker CLI)', (t) => {
  let out;
  try { out = execFileSync('docker', ['logs', '--tail', '50', process.env.GATEWAY_CONTAINER ?? 'shopflow-api-gateway-1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return t.skip('docker CLI / container not available'); }
  const rows = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.ok(rows.length > 0);
  for (const k of ['timestamp', 'method', 'uri', 'request', 'status', 'upstream_addr', 'upstream_response_time']) assert.ok(k in rows[0], `log has ${k}`);
  assert.match(rows.find((r) => r.upstream_addr && r.upstream_addr !== '-').upstream_addr, /^\d+\.\d+\.\d+\.\d+:\d+$/, 'upstream_addr is a container IP:port the mapper can resolve');
});
