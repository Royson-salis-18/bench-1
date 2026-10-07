// notifier: consumes order.placed and sends the confirmation e-mail. Customer-facing path never waits on it.
import crypto from 'node:crypto';
import { envInt, env, envBool, log, onShutdown, call, connectBus, ensureStream, consume, createServer, waitFor, streamLag, setGauge } from '../../lib/index.js';

const ORDERS = env('ORDERS_URL', 'http://orders:3005');
const CATALOG = env('CATALOG_URL', 'http://catalog:3001');
const ENRICH = envBool('NOTIFIER_ENRICH_FROM_CATALOG', false);

async function handle(evt) {
  if (evt.v !== 1) throw new Error(`unsupported event schema v${evt.v}`); // consumer only knows v1
  const order = await call(ORDERS, `/orders/${evt.orderId}`, { timeoutMs: 2000 });
  let lines = order.items;
  if (ENRICH) lines = await Promise.all(order.items.map((i) => call(CATALOG, `/products/${i.productId}`, { timeoutMs: 1000, retry: { max: 0, backoffMs: 0 } }).then((p) => ({ ...i, name: p.name })).catch(() => i)));
  // Render the e-mail (templating + DKIM-style signing is real CPU work)
  let sig = Buffer.from(JSON.stringify(lines));
  for (let i = 0; i < envInt('RENDER_ROUNDS', 2000); i++) sig = crypto.createHash('sha256').update(sig).digest();
  log.info('confirmation sent', { orderId: evt.orderId, to: order.email, lines: lines.length });
}

const bus = await waitFor('event-bus', async () => { const b = await connectBus(); await ensureStream(b, 'ORDERS', ['orders.*']); return b; }, { retries: envInt('BUS_CONNECT_RETRIES', 30), delayMs: 1000 });
const consumer = await consume(bus, { stream: 'ORDERS', durable: 'notifier', filter: 'orders.placed', prefix: 'NOTIFIER', handler: handle });
setInterval(async () => { try { const l = await streamLag(bus, 'ORDERS', 'notifier'); setGauge('queue_pending_messages', 'Unconsumed messages', l.pending); } catch {} }, 5000).unref();
const server = createServer({ port: envInt('PORT', 3006), routes: [], ready: async () => !bus.nc.isClosed() });
await server.listen();
onShutdown(async () => { consumer.stop(); await bus.nc.drain(); await server.drain(); });
