// payments: charges a card through the external PSP. Stateless; idempotency is delegated to the PSP
// via the Idempotency-Key header, which is how card processors are designed to be used.
import { envInt, env, log, createServer, HttpError, onShutdown, call, retryFromEnv } from '../../lib/index.js';

const PSP = env('PSP_URL', 'http://psp-sandbox:4000');
const retry = retryFromEnv('PSP', { max: 2, backoffMs: 200 });

const routes = [
  ['POST', '/charges', async ({ body }) => {
    if (!body?.orderId || !(body.amountCents > 0)) throw new HttpError(400, 'orderId and amountCents required');
    try {
      const r = await call(PSP, '/v1/charges', {
        method: 'POST', body: { amount: body.amountCents, currency: 'usd', metadata: { orderId: body.orderId } },
        headers: { 'idempotency-key': `order-${body.orderId}` }, timeoutMs: envInt('PSP_TIMEOUT_MS', 3000), retry,
      });
      if (r.status !== 'succeeded') throw new HttpError(402, 'card declined');
      return { status: 201, body: { chargeId: r.id, status: r.status } };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log.error('psp call failed', { orderId: body.orderId, err: e.message });
      throw new HttpError(502, 'payment provider unavailable');
    }
  }],
];
const server = createServer({ port: envInt('PORT', 3004), routes });
await server.listen();
onShutdown(() => server.drain());
