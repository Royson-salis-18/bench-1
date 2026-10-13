#!/usr/bin/env node
// Closed-loop load generator for shopflow (self-contained; journeys are in ./journeys.js).
//   node loadgen/loadgen.mjs [--continuous]  --base http://localhost:8080 --concurrency 20 --duration 60 --users 200 [--mix browse=60,cart=25,checkout=15]
//   node loadgen/loadgen.mjs --organic [--base-rps 0.6] [--wave-min 30] [--seed text] [--max-inflight 200] [--no-bursts] [--no-flash]
//     organic = OPEN-LOOP: visitor sessions arrive by a time-varying Poisson process (daily wave x bursts x flash crowds), each walks a Markov chain.
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
const organic = args.includes('--organic');   // visitor sessions with think times + a day/night wave in active visitors
const { journeys, chain } = await import(pathToFileURL(path.resolve(import.meta.dirname, 'journeys.js')).href);
const { RateModel, arrivals, walk, makeRng, userPicker } = await import(pathToFileURL(path.resolve(import.meta.dirname, 'traffic-model.mjs')).href);
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
const period = Number(opt('wave-min', 30)) * 60000;   // one "day" of the wave
if (organic) {
  const seed = opt('seed', `${Date.now()}`);
  const model = new RateModel(seed, {
    baseRps: Number(opt('base-rps', process.env.BASE_RPS ?? 0.6)), periodSec: period / 1000,
    ...(args.includes('--no-bursts') ? { burst: { mult: 1 } } : {}), ...(args.includes('--no-flash') ? { flash: { ratePerHour: 0 } } : {}),
  });
  const maxInflight = Number(opt('max-inflight', 200));
  const pickUser = userPicker(makeRng(`${seed}|users`), users);
  const t0 = Date.now(); let inflight = 0, started = 0, dropped = 0; const open = new Set();
  console.error(`organic traffic: seed=${seed} base=${model.p.baseRps} sessions/s, day=${opt('wave-min', 30)} min, open-loop, max ${maxInflight} in flight`);
  const report = setInterval(() => console.error(`  sessions started=${started} in-flight=${inflight} dropped=${dropped} rate_now=${model.rate((Date.now() - t0) / 1000).toFixed(2)}/s`), 30000);
  for (const t of arrivals(model, makeRng(`${seed}|arrivals`), duration)) {
    const wait = t * 1000 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() >= end) break;
    if (inflight >= maxInflight) { dropped++; continue; }          // protect the generator, and say so, rather than slow the arrivals
    const id = started++, rng = makeRng(`${seed}|s|${id}`), user = pickUser();
    const ctx = { http, user: () => user, rand: (n) => rng.int(n), thinkMs: Number(opt('think-ms', 1500)) };
    inflight++;
    const p = walk(chain, ctx, rng, { thinkMs: ctx.thinkMs }).catch(() => {}).finally(() => { inflight--; open.delete(p); });
    open.add(p);
  }
  clearInterval(report);
  await Promise.race([Promise.all([...open]), new Promise((r) => setTimeout(r, 20000))]);
} else await Promise.all(Array.from({ length: concurrency }, async () => {
  while (Date.now() < end) {
    let r = Math.random() * total, j = pool[0];
    for (const x of pool) { if ((r -= x.weight) < 0) { j = x; break; } }
    const ctx = { http, user: () => `u${Math.floor(Math.random() * users)}`, rand: (n) => Math.floor(Math.random() * n), thinkMs };
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
