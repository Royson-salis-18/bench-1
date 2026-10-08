// Shopper behaviour. Weights are the default traffic mix (browse-heavy, like real retail).
export const journeys = [
  { name: 'browse', weight: 60, run: async (c) => {
    const cats = ['shoes', 'shirts', 'hats', 'bags', 'socks', 'jackets'];
    await c.http('GET', `/api/catalog/products?category=${cats[c.rand(cats.length)]}&limit=20`);
    await c.http('GET', `/api/catalog/products/${1 + c.rand(5000)}`);
  } },
  { name: 'cart', weight: 25, run: async (c) => {
    const u = c.user();
    for (let i = 0; i < 1 + c.rand(3); i++) await c.http('POST', `/api/cart/${u}/items`, { productId: 1 + c.rand(5000), qty: 1, priceCents: 1000 });
    await c.http('GET', `/api/cart/${u}`);
    await c.http('GET', `/api/orders?userId=${u}`);
  } },
  { name: 'checkout', weight: 15, run: async (c) => {
    const u = c.user();
    await c.http('POST', `/api/cart/${u}/items`, { productId: 1 + c.rand(5000), qty: 1, priceCents: 1000 });
    await c.http('POST', '/api/checkout', { userId: u, email: `${u}@example.test` });
  } },
];

// Organic visitor session: a funnel with human think times, popular products (Zipf-like) and returning users.
// Used by `loadgen.mjs --organic`; each worker runs whole sessions instead of isolated journeys.
const CATS = ['shoes', 'shirts', 'hats', 'bags', 'socks', 'jackets'];
const popular = (c, n = 5000) => Math.min(n, 1 + Math.floor(Math.pow(Math.random(), 3) * n));
const think = (c) => new Promise((r) => setTimeout(r, Math.min(20000, Math.exp(Math.log(c.thinkMs ?? 1500) + 0.8 * (Math.random() + Math.random() + Math.random() - 1.5)))));
export async function session(c) {
  const u = c.user();
  const prices = new Map();
  const seen = [];
  const pages = 1 + c.rand(4);
  for (let p = 0; p < pages; p++) {
    const r = await c.http('GET', `/api/catalog/products?category=${CATS[c.rand(CATS.length)]}&limit=40`);
    await think(c);
    const list = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data?.products) ? r.data.products : Array.isArray(r.data) ? r.data : [];
    const looks = 1 + c.rand(3);
    for (let i = 0; i < looks; i++) {
      const pick = list.length ? list[Math.min(list.length - 1, Math.floor(Math.pow(Math.random(), 2) * list.length))] : { id: popular(c), price_cents: 1000 };
      const d = await c.http('GET', `/api/catalog/products/${pick.id}`);
      seen.push({ id: pick.id, price: d.data?.price_cents ?? pick.price_cents ?? 1000 });
      await think(c);
    }
  }
  if (Math.random() < 0.35 && seen.length) {
    for (const s of seen.slice(0, 1 + c.rand(3))) { await c.http('POST', `/api/cart/${u}/items`, { productId: s.id, qty: 1, priceCents: s.price }); await think(c); }
    await c.http('GET', `/api/cart/${u}`);
    await think(c);
    if (Math.random() < 0.4) {
      await c.http('POST', '/api/checkout', { userId: u, email: `${u}@example.test` });
      await think(c);
      await c.http('GET', `/api/orders?userId=${u}`);
    }
  } else if (Math.random() < 0.1) await c.http('GET', `/api/orders?userId=${u}`);
}
