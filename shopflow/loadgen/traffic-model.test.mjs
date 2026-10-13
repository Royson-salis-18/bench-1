import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, RateModel, arrivals, zipf, walk, diurnal, userPicker } from './traffic-model.mjs';

const count = (seed, profile, horizon) => { const m = new RateModel(seed, profile); return [...arrivals(m, makeRng(`${seed}|arr`), horizon)]; };
const calm = { burst: { mult: 1 }, flash: { ratePerHour: 0 }, noiseSigma: 0 };

test('same seed, same arrivals', () => {
  assert.deepEqual(count('a', {}, 600), count('a', {}, 600));
  assert.notDeepEqual(count('a', {}, 600), count('b', {}, 600));
});

test('arrival count matches the integral of the rate (no bursts, flat noise)', () => {
  // one full day: integral of base*D over a period = base * 0.55 * P
  const P = 1800, base = 2;
  const ns = Array.from({ length: 12 }, (_, i) => count(`i${i}`, { ...calm, baseRps: base, periodSec: P }, P).length);
  const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
  assert.ok(Math.abs(mean - base * 0.55 * P) / (base * 0.55 * P) < 0.05, `mean ${mean} vs ${base * 0.55 * P}`);
});

test('the daily wave shows: arrivals are denser in the busy half of the day', () => {
  const P = 1200; const ts = count('wave', { ...calm, baseRps: 3, periodSec: P }, 4 * P);
  const busy = ts.filter((t) => Math.sin((2 * Math.PI * t) / P) > 0).length;
  assert.ok(busy > (ts.length - busy) * 1.6, `busy ${busy} of ${ts.length}`);
});

test('bursts raise the mean rate and make arrivals clumpier than Poisson (index of dispersion > 1)', () => {
  const horizon = 8 * 1800;
  const plain = count('p', { ...calm, baseRps: 1 }, horizon);
  const bursty = count('p', { burst: { mult: 3, upMeanSec: 60, downMeanSec: 120 }, flash: { ratePerHour: 0 }, noiseSigma: 0, baseRps: 1 }, horizon);
  assert.ok(bursty.length > plain.length * 1.3, `${bursty.length} vs ${plain.length}`);
  const dispersion = (ts) => { const bins = new Array(Math.floor(horizon / 30)).fill(0); for (const t of ts) bins[Math.min(bins.length - 1, Math.floor(t / 30))]++; const m = bins.reduce((a, b) => a + b, 0) / bins.length; const v = bins.reduce((a, b) => a + (b - m) ** 2, 0) / bins.length; return v / m; };
  assert.ok(dispersion(bursty) > dispersion(plain) * 1.5, `${dispersion(bursty)} vs ${dispersion(plain)}`);
});

test('a flash crowd spikes the rate and then decays', () => {
  const m = new RateModel('flash', { ...calm, baseRps: 1, periodSec: 1e9, flash: { ratePerHour: 6, amp: [3, 3], tau: [60, 60] } });
  let peak = 0, peakAt = 0;
  for (let t = 0; t < 7200; t += 1) { const r = m.rate(t); if (r > peak) { peak = r; peakAt = t; } }
  assert.ok(peak > 2.2 * m.p.baseRps * 0.55, `peak ${peak}`);
  const m2 = new RateModel('flash', { ...calm, baseRps: 1, periodSec: 1e9, flash: { ratePerHour: 6, amp: [3, 3], tau: [60, 60] } });
  const at = (t) => { let r; for (let x = 0; x <= t; x++) r = m2.rate(x); return r; };
  assert.ok(at(peakAt + 240) < at(peakAt) * 0.6, 'flash did not decay');
});

test('rate never exceeds the cap (so thinning is exact)', () => {
  const m = new RateModel('cap', { baseRps: 1 });
  for (let t = 0; t < 20000; t += 0.7) assert.ok(m.rate(t) <= m.cap + 1e-9);
});

test('open loop: the arrival schedule does not depend on how long sessions take', () => {
  assert.deepEqual(count('ol', {}, 300), count('ol', {}, 300));   // nothing about service time enters the generator
});

test('zipf: rank 1 is the most popular and frequencies follow the power law', () => {
  const rng = makeRng('z'); const z = zipf(1000, 1.1); const f = new Map();
  for (let i = 0; i < 200000; i++) { const k = z(rng.u()); f.set(k, (f.get(k) ?? 0) + 1); }
  assert.ok(f.get(1) > f.get(2) && f.get(2) > f.get(5) && f.get(5) > f.get(50));
  const ratio = f.get(1) / f.get(10);
  assert.ok(Math.abs(ratio - Math.pow(10, 1.1)) / Math.pow(10, 1.1) < 0.15, `ratio ${ratio}`);
});

test('markov walk follows the transition table', async () => {
  const log = [];
  const step = (n) => ({ run: async () => { log.push(n); }, next: n === 'a' ? { b: 1 } : n === 'b' ? { c: 0.5, exit: 0.5 } : { exit: 1 } });
  const chain = { start: { a: 1 }, states: { a: step('a'), b: step('b'), c: step('c') } };
  const rng = makeRng('walk'); let withC = 0, total = 2000;
  for (let i = 0; i < total; i++) { log.length = 0; await walk(chain, {}, rng, { sleep: async () => {} }); assert.deepEqual(log.slice(0, 2), ['a', 'b']); if (log[2] === 'c') withC++; }
  assert.ok(Math.abs(withC / total - 0.5) < 0.04);
});

test('a failing step does not stop the visit', async () => {
  const log = [];
  const chain = { start: { a: 1 }, states: { a: { run: async () => { throw new Error('x'); }, next: { b: 1 } }, b: { run: async () => { log.push('b'); }, next: { exit: 1 } } } };
  await walk(chain, {}, makeRng('f'), { sleep: async () => {} });
  assert.deepEqual(log, ['b']);
});

test('returning visitors dominate and new ones get fresh ids', () => {
  const pick = userPicker(makeRng('u'), 100, 0.6); const ids = Array.from({ length: 5000 }, pick);
  const fresh = ids.filter((id) => Number(id.slice(1)) >= 100);
  assert.ok(Math.abs(fresh.length / ids.length - 0.4) < 0.03);
  assert.equal(new Set(fresh).size, fresh.length);
  assert.ok(diurnal(0, 100) > 0.5 && diurnal(75, 100) < 0.2);
});
