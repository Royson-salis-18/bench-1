// Tiny HTTP helper + service map for the API tests. Override hosts/ports with env if you run elsewhere.
export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const SVC = {
  catalog: process.env.CATALOG_URL ?? 'http://localhost:3001',
  cart: process.env.CART_URL ?? 'http://localhost:3002',
  inventory: process.env.INVENTORY_URL ?? 'http://localhost:3003',
  payments: process.env.PAYMENTS_URL ?? 'http://localhost:3004',
  orders: process.env.ORDERS_URL ?? 'http://localhost:3005',
  notifier: process.env.NOTIFIER_URL ?? 'http://localhost:3006',
  psp: process.env.PSP_URL ?? 'http://localhost:4000',
};
export const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

export async function req(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json, headers: res.headers, text };
}
export const get = (b, p, h) => req(b, 'GET', p, undefined, h);
export const post = (b, p, body, h) => req(b, 'POST', p, body, h);
export const del = (b, p) => req(b, 'DELETE', p);
export const uid = (p = 'u') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
export async function eventually(fn, { timeoutMs = 20000, everyMs = 500 } = {}) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, everyMs)); }
  throw new Error(`condition not met in ${timeoutMs}ms (last: ${last?.message ?? JSON.stringify(last)})`);
}
