// orders: checkout orchestration + order history. Owns orders-db and publishes order.placed.
import crypto from 'node:crypto';
import { envInt, env, envBool, log, createServer, HttpError, createPool, pingPool, poolStats, waitFor, onShutdown, call, retryFromEnv, connectBus, ensureStream, publish, setGauge } from '../../lib/index.js';

const db = createPool('ORDERS_DB', { database: 'orders' });
const CART = env('CART_URL', 'http://cart:3002');
const INVENTORY = env('INVENTORY_URL', 'http://inventory:3003');
const PAYMENTS = env('PAYMENTS_URL', 'http://payments:3004');
const T = { cart: envInt('CART_TIMEOUT_MS', 1500), inv: envInt('INVENTORY_TIMEOUT_MS', 2000), pay: envInt('PAYMENTS_TIMEOUT_MS', 8000) };
const payRetry = retryFromEnv('PAYMENTS', { max: 1, backoffMs: 250 });
const SCHEMA = envInt('ORDER_EVENT_SCHEMA', 1);
let bus;

const routes = [
  ['POST', '/checkout', async ({ body }) => {
    const userId = body?.userId;
    if (!userId) throw new HttpError(400, 'userId required');
    const cart = await call(CART, `/carts/${encodeURIComponent(userId)}`, { timeoutMs: T.cart });
    if (!cart.items.length) throw new HttpError(409, 'cart is empty');
    const orderId = crypto.randomUUID();

    await call(INVENTORY, '/reserve', { method: 'POST', body: { orderId, items: cart.items.map((i) => ({ sku: `SKU-${String(i.productId).padStart(5, '0')}`, qty: i.qty })) }, timeoutMs: T.inv })
      .catch((e) => { throw e.status === 409 ? new HttpError(409, 'out of stock') : new HttpError(502, 'inventory unavailable'); });
    try {
      await call(PAYMENTS, '/charges', { method: 'POST', body: { orderId, amountCents: cart.totalCents }, timeoutMs: T.pay, retry: payRetry });
    } catch (e) {
      await call(INVENTORY, '/release', { method: 'POST', body: { orderId }, timeoutMs: T.inv, retry: { max: 2, backoffMs: 100 } }).catch(() => {});
      throw e.status === 402 ? new HttpError(402, 'card declined') : new HttpError(502, 'payment failed');
    }
    await db.query('insert into orders(id, user_id, email, total_cents, status, items) values ($1,$2,$3,$4,$5,$6)',
      [orderId, userId, body.email ?? `${userId}@example.test`, cart.totalCents, 'paid', JSON.stringify(cart.items)]);
    await call(CART, `/carts/${encodeURIComponent(userId)}`, { method: 'DELETE', timeoutMs: T.cart, retry: { max: 0, backoffMs: 0 } }).catch(() => {});
    publish(bus, 'orders.placed', SCHEMA === 1 ? { v: 1, orderId, userId } : { v: SCHEMA, order: { id: orderId, customer: { id: userId } } })
      .catch((e) => log.error('event publish failed', { orderId, err: e.message }));
    return { status: 201, body: { orderId, totalCents: cart.totalCents } };
  }],
  // Order history. Newest first, per user.
  ['GET', '/orders', async ({ query }) => {
    if (!query.userId) throw new HttpError(400, 'userId required');
    const { rows } = await db.query('select id, user_id, total_cents, status, created_at from orders where user_id=$1 order by created_at desc limit 20', [query.userId]);
    return { body: { orders: rows } };
  }],
  ['GET', '/orders/:id', async ({ params }) => {
    const { rows } = await db.query('select * from orders where id=$1', [params.id]);
    if (!rows[0]) throw new HttpError(404, 'order not found');
    return { body: rows[0] };
  }],
];

await waitFor('orders-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
bus = await waitFor('event-bus', async () => { const b = await connectBus(); await ensureStream(b, 'ORDERS', ['orders.*']); return b; }, { retries: envInt('BUS_CONNECT_RETRIES', 30), delayMs: 1000 });
setInterval(() => { const s = poolStats(db); setGauge('db_pool_waiting', 'Queries waiting for a pooled connection', s.waiting); }, 2000).unref();
const server = createServer({ port: envInt('PORT', 3005), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await bus.nc.drain(); await db.end(); });
