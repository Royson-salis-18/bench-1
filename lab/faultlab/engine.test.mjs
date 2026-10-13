import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRng, planCampaign, sampleFault, downstreamOf, CLASSES, PROFILES } from './engine.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./catalog.shopflow.json', import.meta.url)));
const H = 6 * 3600;
const plan = (seed, extra = {}) => planCampaign({ catalog, profile: 'realistic', seed, horizonSec: H, ...extra });

test('same seed gives the same plan; a different seed gives a different one', () => {
  assert.deepEqual(plan('a').events, plan('a').events);
  assert.notDeepEqual(plan('a').events.map((e) => e.target), plan('b').events.map((e) => e.target));
});

test('plans are sorted, inside the horizon, never touch protected services, and carry ground truth', () => {
  const { events } = plan('t1');
  assert.ok(events.length > 10);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at >= events[i - 1].at);
  for (const e of events) {
    assert.ok(e.at >= 0 && e.at < H);
    assert.notEqual(e.target, 'traffic');
    assert.equal(e.truth.rootCause, e.target);
    assert.ok(e.durationSec > 0);
  }
});

test('limits hold: at most K concurrent, no service faulted twice at once, cooldown respected', () => {
  for (const name of ['gentle', 'realistic', 'stormy']) {
    const P = PROFILES[name];
    for (const seed of ['x', 'y', 'z']) {
      const { events } = plan(seed, { profile: name });
      for (const e of events) {
        const overlapping = events.filter((o) => o.at <= e.at && e.at < o.at + o.durationSec);
        assert.ok(overlapping.length <= P.maxConcurrent, `${name}/${seed}: ${overlapping.length} concurrent at ${e.at}`);
      }
      for (const e of events) {
        const same = events.filter((o) => o.target === e.target && o !== e && o.at < e.at);
        for (const o of same) assert.ok(e.at >= o.at + o.durationSec + P.cooldownSec, `${name}/${seed}: ${e.target} re-faulted inside its cooldown`);
      }
    }
  }
});

test('blast budget: the union of downstream reach of simultaneous faults stays under B', () => {
  const { reach } = downstreamOf(catalog);
  const n = Object.values(catalog.services).filter((v) => !v.protected).length;
  const P = PROFILES.stormy;
  const { events } = plan('blast', { profile: 'stormy' });
  for (const e of events) {
    const live = events.filter((o) => o.at <= e.at && e.at < o.at + o.durationSec);
    const u = new Set();
    for (const o of live) { u.add(o.target); for (const x of reach.get(o.target)) u.add(x); }
    assert.ok(u.size / n <= P.blastBudget + 1e-9, `blast ${u.size}/${n} at ${e.at}`);
  }
});

test('arrival count tracks the configured rate (mean over many seeds, before limits bite)', () => {
  // gentle: one fault in flight at a time, so blocking is small; expected count = rate * horizon
  const seeds = Array.from({ length: 40 }, (_, i) => `r${i}`);
  const counts = seeds.map((s) => planCampaign({ catalog, profile: { ...PROFILES.gentle, cooldownSec: 0, maxConcurrent: 99, blastBudget: 1 }, seed: s, horizonSec: H }).events.length);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const expected = (PROFILES.gentle.ratePerMin / 60) * H;
  assert.ok(Math.abs(mean - expected) / expected < 0.12, `mean ${mean} vs expected ${expected}`);
});

test('load coupling: with a strong wave, more faults land in the busy half of the day', () => {
  const period = 3600;
  let busy = 0, quiet = 0;
  for (let i = 0; i < 40; i++) {
    const { events } = planCampaign({ catalog, profile: { ...PROFILES.gentle, ratePerMin: 0.5, loadCoupling: 0.9, cooldownSec: 0, maxConcurrent: 99, blastBudget: 1 }, seed: `w${i}`, horizonSec: 4 * period, periodSec: period });
    for (const e of events) (Math.sin((2 * Math.PI * e.at) / period) > 0 ? busy++ : quiet++);
  }
  assert.ok(busy > quiet * 1.4, `busy ${busy} quiet ${quiet}`);
});

test('class mix follows the weights, and filters are honoured', () => {
  const seen = {};
  for (let i = 0; i < 30; i++) for (const e of plan(`m${i}`).events) seen[e.class] = (seen[e.class] ?? 0) + 1;
  const total = Object.values(seen).reduce((a, b) => a + b, 0);
  for (const c of Object.keys(CLASSES)) assert.ok(seen[c] > 0, `${c} never sampled`);
  assert.ok(seen.brownout / total > 0.15 && seen.brownout / total < 0.3);
  const only = plan('f', { only: { classes: ['pause'], targets: ['cart', 'orders'] } }).events;
  assert.ok(only.length > 0 && only.every((e) => e.class === 'pause' && ['cart', 'orders'].includes(e.target)));
});

test('sampled faults respect their bounds', () => {
  const rng = makeRng('bounds');
  for (let i = 0; i < 2000; i++) {
    for (const [c, spec] of Object.entries(CLASSES)) {
      const f = sampleFault(rng, c);
      if (spec.dur) assert.ok(f.durationSec >= spec.dur.min && f.durationSec <= spec.dur.max);
      if (f.severity !== undefined) assert.ok(f.severity > 0 && f.severity < 1);
      if (c === 'flap') assert.ok(f.duty >= 0.2 && f.duty <= 0.8 && f.periodSec >= 6 && f.periodSec <= 20);
      if (c === 'crash-loop') assert.ok(f.kills >= 3 && f.kills <= 8);
      if (f.rampSec) assert.ok(f.rampSec < f.durationSec);
    }
  }
});

test('compound faults happen near their parent and are labelled', () => {
  const { events } = plan('c', { profile: { ...PROFILES.stormy, compoundProb: 1 } });
  const byId = new Map(events.map((e) => [e.id, e]));
  const compound = events.filter((e) => e.compoundOf);
  assert.ok(compound.length > 5);
  const { direct } = downstreamOf(catalog);
  let near = 0;
  for (const c of compound) {
    const p = byId.get(c.compoundOf);
    assert.ok(p && p.at <= c.at);
    const nb = new Set([...(catalog.services[p.target].deps ?? []), ...(direct.get(p.target) ?? [])]);
    if (nb.has(c.target)) near++;
  }
  assert.ok(near / compound.length > 0.4, `only ${near}/${compound.length} compound faults were adjacent`);
});

test('ground truth names exactly the services that depend on the target', () => {
  const { events } = plan('truth');
  const db = events.find((e) => e.target === 'catalog-db') ?? { truth: { expectedAffected: [...downstreamOf(catalog).reach.get('catalog-db')].sort() } };
  assert.deepEqual(db.truth.expectedAffected, ['api-gateway', 'cart', 'catalog', 'inventory', 'notifier', 'orders']);
});

test('the traffic generator is never a target and never counted as affected', () => {
  const { events } = plan('prot');
  for (const e of events) { assert.notEqual(e.target, 'traffic'); assert.ok(!e.truth.expectedAffected.includes('traffic')); }
});

test('beta sampler has the right mean', () => {
  const rng = makeRng('beta');
  const xs = Array.from({ length: 20000 }, () => rng.beta(2.5, 2));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean - 2.5 / 4.5) < 0.01, `mean ${mean}`);
});
