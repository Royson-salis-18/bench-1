#!/usr/bin/env node
// Closed-loop load generator for shopflow (self-contained; journeys are in ./journeys.js).
//   node loadgen/loadgen.mjs [--continuous]  --base http://localhost:8080 --concurrency 20 --duration 60 --users 200 [--mix browse=60,cart=25,checkout=15]
// Prints a stats line every 5s and a JSON summary at the end (stdout), so scenarios can assert on it.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const args = process.argv.slice(2);
const subject = 'shopflow';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt('base', process.env.BASE_URL ?? 'http://localhost:8080');
const concurrency = Number(opt('concurrency', 10));
const continuous = args.includes('--continuous');   // run until stopped; keeps no per-request history (safe for days)
const duration = continuous ? Infinity : Number(opt('duration', 30));
process.on('SIGTERM', () => process.exit(0));
const users = Number(opt('users', 100));
const thinkMs = Number(opt('think-ms', 50));
const mixArg = opt('mix', '');
const { journeys } = await import(pathToFileURL(path.resolve(import.meta.dirname, 'journeys.js')).href);
const weights = Object.fromEntries(mixArg.split(',').filter(Boolean).map((p) => p.split('=')).map(([k, v]) => [k, Number(v)]));
const pool = journeys.map((j) => ({ ...j, weight: weights[j.name] ?? j.weight }));
const total = pool.reduce((s, j) => s + j.weight, 0);

const stats = { window: [], all: [] };
async function http(method, p, body, headers) {
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Number(opt('timeout-ms', 15000))) });
    status = res.status;
    const text = await res.text();
    var data; try { data = JSON.parse(text); } catch { data = text; }
  } catch { status = 0; }
  const rec = { route: `${method} ${p.replace(/[0-9a-f-]{8,}|\d+/g, ':n').split('?')[0]}`, status, ms: performance.now() - t0 };
  stats.window.push(rec); if (!continuous) stats.all.push(rec);
  return { status, ms: rec.ms, data };
}
const pct = (a, p) => a.length ? a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const line = (recs, label) => {
  const ms = recs.map((r) => r.ms), err = recs.filter((r) => r.status === 0 || r.status >= 500).length;
  return `${label} n=${recs.length} p50=${pct(ms, .5).toFixed(0)}ms p95=${pct(ms, .95).toFixed(0)}ms err5xx/net=${recs.length ? (100 * err / recs.length).toFixed(1) : 0}%`;
};
const end = Date.now() + duration * 1000;
const ticker = setInterval(() => { console.error(line(stats.window.splice(0), new Date().toISOString().slice(11, 19))); }, 5000);
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (Date.now() < end) {
    let r = Math.random() * total, j = pool[0];
    for (const x of pool) { if ((r -= x.weight) < 0) { j = x; break; } }
    const ctx = { http, user: () => `u${Math.floor(Math.random() * users)}`, rand: (n) => Math.floor(Math.random() * n) };
    try { await j.run(ctx); } catch { /* journey aborted by a failed step */ }
    await new Promise((r) => setTimeout(r, thinkMs));
  }
}));
clearInterval(ticker);
const byRoute = {};
for (const r of stats.all) (byRoute[r.route] ??= []).push(r);
console.log(JSON.stringify({
  total: stats.all.length, rps: +(stats.all.length / duration).toFixed(1),
  overall: line(stats.all, 'all'),
  routes: Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, line(v, k)])),
  status: stats.all.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}),
}, null, 2));
