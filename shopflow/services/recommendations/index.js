// recommendations: "customers also bought". Optional enrichment for product pages.
import { envInt, createServer, onShutdown } from '../../lib/index.js';
const routes = [['GET', '/related/:id', async ({ params }) => {
  const id = Number(params.id);
  return { body: [1, 2, 3].map((n) => ({ productId: ((id + n * 7) % 5000) + 1, score: 1 / n })) };
}]];
const server = createServer({ port: envInt('PORT', 3008), routes });
await server.listen();
onShutdown(() => server.drain());
