import http from 'node:http';
import { log } from './log.js';
import { observeRequest, renderMetrics } from './metrics.js';
import { SERVICE, envInt } from './config.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function compile(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
  return { re, names };
}

/**
 * routes: [['GET', '/products/:id', async ({params, query, body, req}) => ({status?, body})]]
 * Adds /healthz (liveness), /readyz (readiness, via `ready()`), /metrics.
 * Request timeout and body limit are enforced here so no handler can hang a socket forever.
 */
export function createServer({ port, routes, ready = async () => true }) {
  const table = routes.map(([method, pattern, handler]) => ({ method, pattern, handler, ...compile(pattern) }));
  const requestTimeoutMs = envInt('SERVER_REQUEST_TIMEOUT_MS', 30000);
  let inflight = 0;
  let draining = false;

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://x');
    let route = 'unmatched';
    let status = 500;
    inflight++;
    const timer = setTimeout(() => {
      if (!res.headersSent) send(res, 503, { error: 'server request timeout' });
    }, requestTimeoutMs);
    try {
      if (url.pathname === '/healthz') return (status = 200), send(res, 200, { status: 'ok', service: SERVICE });
      if (url.pathname === '/readyz') {
        const ok = !draining && (await ready().catch(() => false));
        return (status = ok ? 200 : 503), send(res, status, { ready: ok });
      }
      if (url.pathname === '/metrics') {
        status = 200;
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(renderMetrics());
      }
      const hit = table.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) return (status = 404), send(res, 404, { error: 'not found' });
      route = hit.pattern;
      const m = hit.re.exec(url.pathname);
      const params = Object.fromEntries(hit.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const body = await readBody(req);
      const out = (await hit.handler({ req, params, query: Object.fromEntries(url.searchParams), body })) ?? {};
      status = out.status ?? 200;
      send(res, status, out.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(res, status, { error: e.message, ...e.extra });
      } else {
        status = 500;
        log.error('unhandled error', { route, err: e.message, stack: e.stack?.split('\n')[1]?.trim() });
        send(res, 500, { error: 'internal error' });
      }
    } finally {
      clearTimeout(timer);
      inflight--;
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      if (!['/healthz', '/readyz', '/metrics'].includes(url.pathname)) {
        observeRequest(req.method, route, status, secs);
        log.info('request', { method: req.method, route, status, ms: Math.round(secs * 1000) });
      }
    }
  });
  server.keepAliveTimeout = 65000; // above typical LB idle timeouts
  server.headersTimeout = 66000;

  return {
    listen: () => new Promise((r) => server.listen(port, '0.0.0.0', () => (log.info('listening', { port }), r()))),
    drain: async () => {
      draining = true;
      await new Promise((r) => server.close(r));
    },
    inflight: () => inflight,
  };
}

function send(res, status, body) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

// ---------------------------------------------------------------- client ----

const agents = new Map();
function agentFor(protocolHost) {
  if (!agents.has(protocolHost)) {
    agents.set(protocolHost, new http.Agent({ keepAlive: true, maxSockets: envInt('HTTP_MAX_SOCKETS', 100) }));
  }
  return agents.get(protocolHost);
}

export class UpstreamError extends Error {
  constructor(message, { status, retriable }) {
    super(message);
    this.status = status;
    this.retriable = retriable;
  }
}

function once(base, path, { method, body, timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        agent: agentFor(u.host),
        headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new UpstreamError(`${method} ${u.host}${u.pathname} -> ${res.statusCode}`, {
            status: res.statusCode,
            retriable: res.statusCode >= 500 || res.statusCode === 429,
          }));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new UpstreamError(`timeout after ${timeoutMs}ms`, { retriable: true })));
    req.on('error', (e) => reject(e instanceof UpstreamError ? e : new UpstreamError(e.code ?? e.message, { retriable: true })));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Service-to-service JSON call with per-attempt timeout and bounded retries.
 * retry: { max: extra attempts, backoffMs: base delay (exponential, full jitter) }
 * The defaults here are what a careful team ships; scenarios override them via env on the caller.
 */
export async function call(base, path, { method = 'GET', body, timeoutMs = 2000, retry = { max: 2, backoffMs: 100 }, headers } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await once(base, path, { method, body, timeoutMs, headers });
    } catch (e) {
      if (!e.retriable || attempt >= retry.max) throw e;
      attempt++;
      const cap = retry.backoffMs * 2 ** (attempt - 1);
      const wait = cap === 0 ? 0 : Math.random() * cap;
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export const retryFromEnv = (prefix, dflt = { max: 2, backoffMs: 100 }) => ({
  max: envInt(`${prefix}_RETRY_MAX`, dflt.max),
  backoffMs: envInt(`${prefix}_RETRY_BACKOFF_MS`, dflt.backoffMs),
});
