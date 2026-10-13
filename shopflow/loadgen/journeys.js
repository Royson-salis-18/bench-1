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

// Organic visitor sessions as a Markov chain (see traffic-model.mjs): where a visitor goes next depends only on where they are.
// Roughly: most visits browse and leave, some look at a product, a few add to a cart, fewer still check out.
import { zipf } from './traffic-model.mjs';
const CATS = ['shoes', 'shirts', 'hats', 'bags', 'socks', 'jackets'];
const popular = zipf(5000, 1.1);
const listOf = (r) => (Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data?.products) ? r.data.products : Array.isArray(r.data) ? r.data : []);

export const chain = {
  start: { browse: 0.83, product: 0.1, orders: 0.07 },
  states: {
    browse: {
      run: async (c, s) => { const r = await c.http('GET', `/api/catalog/products?category=${CATS[c.rand(CATS.length)]}&limit=40`); s.list = listOf(r); },
      next: { product: 0.6, browse: 0.2, exit: 0.2 },
    },
    product: {
      run: async (c, s) => {
        const list = s.list ?? [];
        // popular products are looked at far more than the long tail
        const pick = list.length ? list[Math.min(list.length - 1, popular(Math.random()) % list.length)] : { id: popular(Math.random()), price_cents: 1000 };
        const d = await c.http('GET', `/api/catalog/products/${pick.id}`);
        s.item = { id: pick.id, price: d.data?.price_cents ?? pick.price_cents ?? 1000 };
      },
      next: { product: 0.25, browse: 0.2, add: 0.3, exit: 0.25 },
    },
    add: {
      run: async (c, s) => { const it = s.item ?? { id: popular(Math.random()), price: 1000 }; await c.http('POST', `/api/cart/${c.user()}/items`, { productId: it.id, qty: 1, priceCents: it.price }); s.inCart = true; },
      next: { cart: 0.45, browse: 0.3, product: 0.15, exit: 0.1 },
    },
    cart: {
      run: async (c) => { await c.http('GET', `/api/cart/${c.user()}`); },
      next: { checkout: 0.35, browse: 0.25, exit: 0.4 },
    },
    checkout: {
      run: async (c, s) => { if (s.inCart) await c.http('POST', '/api/checkout', { userId: c.user(), email: `${c.user()}@example.test` }); },
      next: { orders: 0.6, exit: 0.4 },
    },
    orders: {
      run: async (c) => { await c.http('GET', `/api/orders?userId=${c.user()}`); },
      next: { browse: 0.2, exit: 0.8 },
    },
  },
};
