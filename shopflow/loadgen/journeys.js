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
