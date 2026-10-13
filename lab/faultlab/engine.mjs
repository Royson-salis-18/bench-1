// faultlab/engine.mjs: the planner. PURE: no docker, no clock, no files. Same seed + same catalog + same profile
// => the same plan, which is what makes a campaign reproducible and testable.
//
// Model (see docs/FAULT_INJECTION.md for the derivation):
//   arrivals   non-homogeneous Poisson process, intensity  L(t) = L0 * (1 - k + k * D(t)/mean(D))   (Lewis-Shedler thinning)
//   class      categorical, weight w_c * role multiplier
//   target     categorical over eligible services, weight  hazard_s * roleMult[role_s][c]
//   duration   lognormal(median, sigma) clipped to [min, max]
//   severity   Beta(a, b)
//   compound   with probability rho a second fault follows after Exp(tau), usually next to the first
//   limits     at most K concurrent, per-service cooldown, blast-radius budget B (share of services in the union of
//              the faulted services' downstream reach)
import crypto from 'node:crypto';

// ---------------------------------------------------------------- seeded randomness
export function makeRng(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  let a = h.readUInt32LE(0) >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const gamma = (k) => {
    if (k < 1) return gamma(k + 1) * Math.pow(u(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v; const w = u();
      if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  return {
    u, normal,
    exp: (mean) => -mean * Math.log(1 - u()),
    range: (lo, hi) => lo + (hi - lo) * u(),
    int: (lo, hi) => lo + Math.floor(u() * (hi - lo + 1)),
    chance: (p) => u() < p,
    lognormal: (median, sigma) => median * Math.exp(sigma * normal()),
    beta: (a, b) => { const x = gamma(a), y = gamma(b); return x / (x + y); },
    poisson: (lambda) => { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; },
    pick: (items, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      if (!(total > 0)) return null;
      let r = u() * total;
      for (let i = 0; i < items.length; i++) { if ((r -= weights[i]) < 0) return items[i]; }
      return items[items.length - 1];
    },
  };
}

// ---------------------------------------------------------------- fault classes
// What each class does to a container is in actuators.mjs; here is only HOW LONG, HOW BAD, HOW OFTEN.
const dur = (median, sigma, min, max) => ({ median, sigma, min, max });
export const CLASSES = {
  crash:        { weight: 0.18, desc: 'SIGKILL; the restart policy brings it back',                 recoverySec: 20 },
  'crash-loop': { weight: 0.06, desc: 'killed again and again as it comes back',                    kills: [3, 8], gap: dur(12, 0.4, 6, 40) },
  stop:         { weight: 0.12, desc: 'stopped, connection refused, then started',                  dur: dur(75, 0.7, 20, 600) },
  pause:        { weight: 0.18, desc: 'process frozen: connects, never answers (timeouts)',         dur: dur(60, 0.6, 15, 420) },
  brownout:     { weight: 0.22, desc: 'CPU throttled: slow, not dead (gray failure)',               dur: dur(150, 0.6, 40, 900), severity: [2.5, 2], rampProb: 0.4, ramp: [20, 90] },
  memory:       { weight: 0.06, desc: 'memory limit squeezed towards its working set',              dur: dur(150, 0.6, 40, 900), severity: [2, 2] },
  partition:    { weight: 0.10, desc: 'detached from the network',                                  dur: dur(50, 0.6, 15, 300) },
  flap:         { weight: 0.08, desc: 'frozen/running in turns (intermittent)',                     dur: dur(100, 0.5, 40, 400), period: [6, 20], duty: [2, 2, 0.2, 0.8] },
};

// Per role, how much more or less likely each class is (1 = baseline). Roles come from the catalog.
const M = (o) => ({ crash: 1, 'crash-loop': 1, stop: 1, pause: 1, brownout: 1, memory: 1, partition: 1, flap: 1, ...o });
export const ROLE_MULT = {
  gateway:  M({ 'crash-loop': 0.8, stop: 0.6, pause: 1.2, brownout: 1.3, memory: 0.5, partition: 0.5 }),
  service:  M({}),
  database: M({ 'crash-loop': 0.6, pause: 1.3, brownout: 1.5, memory: 1.2, flap: 0.6 }),
  store:    M({ 'crash-loop': 0.6, pause: 1.2, brownout: 1.3, memory: 1.2, flap: 0.6 }),
  queue:    M({ 'crash-loop': 0.7, pause: 1.2, brownout: 1.2, memory: 1.1 }),
  external: M({ stop: 1.5, pause: 1.5, brownout: 1.2, partition: 1.5, memory: 0.4 }),
};

// ---------------------------------------------------------------- profiles
export const PROFILES = {
  gentle:    { ratePerMin: 0.10, maxConcurrent: 1, cooldownSec: 180, compoundProb: 0,    compoundDelaySec: 45, neighbourProb: 0.6, loadCoupling: 0.3, blastBudget: 0.5 },
  realistic: { ratePerMin: 0.25, maxConcurrent: 2, cooldownSec: 120, compoundProb: 0.15, compoundDelaySec: 45, neighbourProb: 0.6, loadCoupling: 0.4, blastBudget: 0.6 },
  stormy:    { ratePerMin: 0.70, maxConcurrent: 3, cooldownSec: 60,  compoundProb: 0.35, compoundDelaySec: 30, neighbourProb: 0.6, loadCoupling: 0.4, blastBudget: 0.75 },
};

/** Daily-load wave shared with the traffic model (loadgen/traffic-model.mjs): faults are likelier at busy times. */
export const diurnal = (tSec, periodSec) => 0.55 + 0.45 * Math.sin((2 * Math.PI * tSec) / periodSec);
const D_MEAN = 0.55, D_MAX = 1.0;

// ---------------------------------------------------------------- graph helpers
/** callers(x): every service that depends on x, directly or through others (the blast radius of x failing). */
export function downstreamOf(catalog) {
  // Protected entries (the traffic generator) are not part of the system under test: they are never faulted and never
  // counted as "affected", so ground truth is about the services only.
  const members = Object.entries(catalog.services).filter(([, v]) => !v.protected);
  const direct = new Map(members.map(([s]) => [s, new Set()]));
  for (const [s, v] of members) for (const d of v.deps ?? []) direct.get(d)?.add(s);
  const out = new Map();
  for (const s of direct.keys()) {
    const seen = new Set(); const stack = [...direct.get(s)];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); stack.push(...(direct.get(x) ?? [])); }
    out.set(s, seen);
  }
  return { reach: out, direct };
}

// ---------------------------------------------------------------- sampling one fault
function sampleDuration(rng, d) { return Math.round(Math.min(d.max, Math.max(d.min, rng.lognormal(d.median, d.sigma)))); }

export function sampleFault(rng, cls, spec = CLASSES[cls]) {
  const f = { class: cls };
  if (cls === 'crash') f.durationSec = spec.recoverySec;
  else if (cls === 'crash-loop') {
    f.kills = rng.int(spec.kills[0], spec.kills[1]);
    f.gapSec = sampleDuration(rng, spec.gap);
    f.durationSec = (f.kills - 1) * f.gapSec + 20;
  } else f.durationSec = sampleDuration(rng, spec.dur);
  if (spec.severity) f.severity = +rng.beta(spec.severity[0], spec.severity[1]).toFixed(3);
  if (cls === 'brownout' && rng.chance(spec.rampProb)) f.rampSec = Math.min(Math.round(f.durationSec * 0.6), rng.int(spec.ramp[0], spec.ramp[1]));
  if (cls === 'flap') {
    f.periodSec = rng.int(spec.period[0], spec.period[1]);
    const [a, b, lo, hi] = spec.duty; f.duty = +Math.min(hi, Math.max(lo, rng.beta(a, b))).toFixed(2);
  }
  return f;
}

// ---------------------------------------------------------------- the campaign planner
/**
 * @param {{catalog, profile?:string|object, seed:string|number, horizonSec:number, periodSec?:number, only?:{classes?:string[], targets?:string[]}}} o
 * @returns {{events:object[], stats:object}}  events are sorted by `at` (seconds from the start of the campaign).
 */
export function planCampaign({ catalog, profile = 'realistic', seed, horizonSec, periodSec = 1800, only = {} }) {
  const P = typeof profile === 'string' ? { ...PROFILES[profile] } : { ...PROFILES.realistic, ...profile };
  if (!P.ratePerMin && P.ratePerMin !== 0) throw new Error(`unknown profile ${profile}`);
  const rng = makeRng(`${seed}|plan`);
  const names = Object.entries(catalog.services).filter(([, v]) => !v.protected).map(([s]) => s);   // the system under test
  const eligible = names.filter((s) => !catalog.services[s].protected && (!only.targets || only.targets.includes(s)));
  const classes = Object.keys(CLASSES).filter((c) => !only.classes || only.classes.includes(c));
  if (!eligible.length || !classes.length) return { events: [], stats: { blocked: 0, expected: 0 } };
  const { reach, direct } = downstreamOf(catalog);
  const k = P.loadCoupling;
  const lambda0 = P.ratePerMin / 60;
  const lambdaAt = (t) => lambda0 * (1 - k + (k * diurnal(t, periodSec)) / D_MEAN);
  const lambdaMax = lambda0 * (1 - k + (k * D_MAX) / D_MEAN);

  const events = []; let blocked = 0; let n = 0;
  const lastEnd = new Map();                                     // service -> when its last fault ended (+ cooldown)
  const activeAt = (t) => events.filter((e) => e.at <= t && t < e.at + e.durationSec);
  const blastShare = (targets) => { const u = new Set(); for (const s of targets) { u.add(s); for (const x of reach.get(s) ?? []) u.add(x); } return u.size / names.length; };

  const classWeight = (c, s) => CLASSES[c].weight * (ROLE_MULT[catalog.services[s].role ?? 'service']?.[c] ?? 1);
  const tryFault = (t, { near = null, compoundOf = null } = {}) => {
    const active = activeAt(t);
    if (active.length >= P.maxConcurrent) { blocked++; return null; }
    for (let attempt = 0; attempt < 6; attempt++) {
      const cls = rng.pick(classes, classes.map((c) => CLASSES[c].weight));
      let pool = eligible;
      if (near && rng.chance(P.neighbourProb)) {
        const nb = new Set([...(catalog.services[near].deps ?? []), ...(direct.get(near) ?? [])]);
        const inPool = eligible.filter((s) => nb.has(s));
        if (inPool.length) pool = inPool;
      }
      const cand = pool.filter((s) => s !== near && !active.some((e) => e.target === s) && (lastEnd.get(s) ?? -1) <= t);
      const target = rng.pick(cand, cand.map((s) => (catalog.services[s].hazard ?? 1) * (ROLE_MULT[catalog.services[s].role ?? 'service']?.[cls] ?? 1)));
      if (!target) continue;
      if (blastShare([...active.map((e) => e.target), target]) > P.blastBudget) continue;
      const f = sampleFault(rng, cls);
      const ev = {
        id: `f${String(++n).padStart(3, '0')}`, at: Math.round(t), target, ...f, source: 'plan', ...(compoundOf ? { compoundOf } : {}),
        truth: { rootCause: target, expectedAffected: [...(reach.get(target) ?? [])].sort(), blastShare: +blastShare([target]).toFixed(3) },
      };
      events.push(ev); lastEnd.set(target, ev.at + ev.durationSec + P.cooldownSec);
      return ev;
    }
    blocked++; return null;
  };

  // primary arrivals by thinning; compound followers are queued and merged in time order
  const followers = [];
  const flush = (upTo) => { followers.sort((a, b) => a.t - b.t); while (followers.length && followers[0].t <= upTo) { const f = followers.shift(); tryFault(f.t, { near: f.near, compoundOf: f.of }); } };
  let t = 0;
  for (;;) {
    t += rng.exp(1 / lambdaMax);
    if (t >= horizonSec) break;
    flush(t);
    if (rng.u() > lambdaAt(t) / lambdaMax) continue;             // thinned out
    const ev = tryFault(t);
    if (ev && rng.chance(P.compoundProb)) followers.push({ t: t + 5 + rng.exp(P.compoundDelaySec), near: ev.target, of: ev.id });
  }
  flush(horizonSec);
  events.sort((a, b) => a.at - b.at);
  const expected = (lambda0 * horizonSec);
  return { events: events.filter((e) => e.at < horizonSec), stats: { blocked, expectedArrivals: +expected.toFixed(2), profile: P, seed: String(seed), horizonSec } };
}
