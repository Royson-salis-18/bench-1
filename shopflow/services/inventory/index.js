// inventory: stock reservations. Lives in its own database on the shared catalog-db Postgres instance.
import { envInt, log, createServer, HttpError, createPool, pingPool, waitFor, onShutdown } from '../../lib/index.js';

const db = createPool('INVENTORY_DB', { database: 'inventory' });

const routes = [
  ['GET', '/stock/:sku', async ({ params }) => {
    const { rows } = await db.query('select sku, available, reserved from stock where sku=$1', [params.sku]);
    if (!rows[0]) throw new HttpError(404, 'unknown sku');
    return { body: rows[0] };
  }],
  // Idempotent per orderId: a retried reserve never double-reserves.
  ['POST', '/reserve', async ({ body }) => {
    if (!body?.orderId || !Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'orderId and items required');
    const c = await db.connect();
    try {
      await c.query('begin');
      const dup = await c.query('select 1 from reservations where order_id=$1', [body.orderId]);
      if (dup.rowCount) { await c.query('commit'); return { body: { reserved: true, duplicate: true } }; }
      for (const it of body.items.sort((a, b) => a.sku.localeCompare(b.sku))) {
        const r = await c.query('update stock set available=available-$2, reserved=reserved+$2 where sku=$1 and available>=$2', [it.sku, it.qty]);
        if (!r.rowCount) { await c.query('rollback'); throw new HttpError(409, 'insufficient stock', { sku: it.sku }); }
        await c.query('insert into reservations(order_id, sku, qty) values ($1,$2,$3)', [body.orderId, it.sku, it.qty]);
      }
      await c.query('commit');
      return { status: 201, body: { reserved: true } };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally { c.release(); }
  }],
  ['POST', '/release', async ({ body }) => {
    const c = await db.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query('delete from reservations where order_id=$1 returning sku, qty', [body?.orderId]);
      for (const r of rows) await c.query('update stock set available=available+$2, reserved=reserved-$2 where sku=$1', [r.sku, r.qty]);
      await c.query('commit');
      return { body: { released: rows.length } };
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }],
];

await waitFor('inventory-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
const server = createServer({ port: envInt('PORT', 3003), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await db.end(); });
