// cart: per-user carts in Redis. Prices are validated against catalog on every add.
import { envInt, envBool, env, log, createServer, HttpError, createRedis, onShutdown, call, retryFromEnv } from '../../lib/index.js';

const store = createRedis('CART_STORE');
const CATALOG = env('CATALOG_URL', 'http://catalog:3001');
const retry = retryFromEnv('CATALOG', { max: 1, backoffMs: 100 });
// Degraded mode: if catalog is unreachable, accept the client-supplied price rather than
// block the shopper. A deliberate product decision ("never lose a sale").
const FAIL_OPEN = envBool('PRICE_VALIDATION_FAIL_OPEN', true);
// Recently-viewed list kept in-process for sub-millisecond reads. 0 means "no limit".
const RECENT_MAX = envInt('RECENT_MAX_ENTRIES', 20000);
const recent = new Map();

function remember(userId, productId) {
  const entry = { productId, at: Date.now(), blob: Buffer.alloc(envInt('RECENT_ENTRY_BYTES', 2048), productId & 0xff) };
  const list = recent.get(userId) ?? [];
  list.push(entry);
  recent.set(userId, list.length > 10 ? list.slice(-10) : list);
  if (RECENT_MAX > 0 && recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}

const key = (u) => `cart:${u}`;
const routes = [
  ['GET', '/carts/:userId', async ({ params }) => {
    const raw = await store.hgetall(key(params.userId));
    const items = Object.entries(raw).map(([productId, v]) => ({ productId: Number(productId), ...JSON.parse(v) }));
    return { body: { userId: params.userId, items, totalCents: items.reduce((s, i) => s + i.priceCents * i.qty, 0) } };
  }],
  ['POST', '/carts/:userId/items', async ({ params, body }) => {
    if (!body?.productId || !(body.qty > 0)) throw new HttpError(400, 'productId and qty>0 required');
    let priceCents;
    try {
      const p = await call(CATALOG, `/products/${body.productId}`, { timeoutMs: envInt('CATALOG_TIMEOUT_MS', 1500), retry });
      priceCents = p.price_cents;
    } catch (e) {
      if (e.status === 404) throw new HttpError(404, 'unknown product');
      if (!FAIL_OPEN || !(body.priceCents > 0)) throw new HttpError(503, 'catalog unavailable');
      log.warn('price validation skipped (fail-open)', { err: e.message, productId: body.productId });
      priceCents = body.priceCents;
    }
    remember(params.userId, body.productId);
    const cur = await store.hget(key(params.userId), String(body.productId));
    const qty = (cur ? JSON.parse(cur).qty : 0) + body.qty;
    await store.hset(key(params.userId), String(body.productId), JSON.stringify({ qty, priceCents }));
    await store.expire(key(params.userId), 7 * 86400);
    return { status: 201, body: { ok: true, qty, priceCents } };
  }],
  ['DELETE', '/carts/:userId', async ({ params }) => { await store.del(key(params.userId)); return { status: 204, body: {} }; }],
];

await store.connect();
const server = createServer({ port: envInt('PORT', 3002), routes, ready: async () => (await store.ping()) === 'PONG' });
await server.listen();
onShutdown(async () => { await server.drain(); store.disconnect(); });
