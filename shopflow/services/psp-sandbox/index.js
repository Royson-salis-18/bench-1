// psp-sandbox: stand-in for a third-party card processor (think stripe-mock / a vendor sandbox).
// It is infrastructure the team does NOT own: its latency and rate limits are facts of life.
import { envInt, envFloat, log, createServer, HttpError, onShutdown } from '../../lib/index.js';

const LATENCY_MS = envInt('PSP_LATENCY_MS', 40);
const LATENCY_JITTER_MS = envInt('PSP_LATENCY_JITTER_MS', 20);
const RATE_LIMIT_RPS = envInt('PSP_RATE_LIMIT_RPS', 0); // 0 = unlimited. Vendors enforce a per-account quota.
const DECLINE_RATE = envFloat('PSP_DECLINE_RATE', 0.02);
let windowStart = Math.floor(Date.now() / 1000), windowCount = 0;
const seen = new Map(); // Idempotency-Key -> response

const routes = [
  ['POST', '/v1/charges', async ({ req, body }) => {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== windowStart) { windowStart = sec; windowCount = 0; }
    if (RATE_LIMIT_RPS > 0 && ++windowCount > RATE_LIMIT_RPS) throw new HttpError(429, 'rate_limit_exceeded', { retry_after: 1 });
    const idem = req.headers['idempotency-key'];
    if (idem && seen.has(idem)) return { body: seen.get(idem) };
    await new Promise((r) => setTimeout(r, LATENCY_MS + Math.random() * LATENCY_JITTER_MS));
    if (!(body?.amount > 0)) throw new HttpError(400, 'invalid_amount');
    const declined = Math.random() < DECLINE_RATE;
    const out = { id: `ch_${Math.random().toString(36).slice(2, 12)}`, status: declined ? 'declined' : 'succeeded', amount: body.amount };
    if (idem) { seen.set(idem, out); if (seen.size > 50000) seen.delete(seen.keys().next().value); }
    return { body: out };
  }],
];
const server = createServer({ port: envInt('PORT', 4000), routes });
await server.listen();
onShutdown(() => server.drain());
