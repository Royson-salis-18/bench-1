// catalog: product reads (cache-aside over Postgres) and a merchandising export.
import { SERVICE, envInt, envBool, env, log, createServer, HttpError, createPool, createRedis, pingPool, waitFor, onShutdown, call, retryFromEnv } from '../../lib/index.js';

const db = createPool('CATALOG_DB', { database: 'catalog' });
const cache = createRedis('CACHE');
const TTL = envInt('CACHE_TTL_S', 120);
const JITTER = envInt('CACHE_TTL_JITTER_S', 30); // spreads expiries so keys don't all die together
const RECS_ENABLED = envBool('RECS_ENABLED', false);
const RECS_URL = env('RECOMMENDATIONS_URL', 'http://recommendations:3008');

async function cached(key, loader) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { log.warn('cache read failed, falling through to db', { err: e.message }); }
  const value = await loader();
  cache.set(key, JSON.stringify(value), 'EX', TTL + Math.floor(Math.random() * (JITTER + 1))).catch(() => {});
  return value;
}

const routes = [
  ['GET', '/products', async ({ query }) => {
    const category = query.category ?? 'all';
    const limit = Math.min(envInt('MAX_PAGE', 500), Number.parseInt(query.limit ?? '50', 10) || 50);
    const body = await cached(`products:${category}:${limit}`, async () => {
      const { rows } = category === 'all'
        ? await db.query('select id, sku, name, category, price_cents, description from products order by id limit $1', [limit])
        : await db.query('select id, sku, name, category, price_cents, description from products where category=$1 order by id limit $2', [category, limit]);
      return rows;
    });
    return { body: { items: body, count: body.length } };
  }],
  ['GET', '/products/:id', async ({ params }) => {
    const p = await cached(`product:${params.id}`, async () => (await db.query('select * from products where id=$1', [params.id])).rows[0] ?? null);
    if (!p) throw new HttpError(404, 'product not found');
    if (RECS_ENABLED) {
      p.related = await call(RECS_URL, `/related/${p.id}`, { timeoutMs: 300, retry: { max: 0, backoffMs: 0 } }).catch(() => []);
    }
    return { body: p };
  }],
  // Merchandising's "download the catalogue with sales rank" button. Joins and aggregates over
  // the whole table; fine for a few thousand products, expensive for a shared database.
  ['GET', '/export', async () => {
    const { rows } = await db.query(`
      select p.category, count(*) products, sum(p.price_cents)::bigint total_cents,
             avg(length(p.description))::int avg_desc, max(p.price_cents) max_price
      from products p
      cross join generate_series(1, $1::int) g
      group by p.category order by p.category`, [envInt('EXPORT_AMPLIFICATION', 40)]);
    return { body: { categories: rows } };
  }],
];

await waitFor('catalog-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
const server = createServer({ port: envInt('PORT', 3001), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await db.end(); cache.disconnect(); });
log.info('catalog up', { service: SERVICE, recs: RECS_ENABLED });
