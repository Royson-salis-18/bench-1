// traffic-model.mjs: organic traffic, as a model. Pure functions plus a seeded rate process; no network here.
// Shared by both benches (identical file). The subject-specific part is the session chain in journeys.js.
//
//   arrivals   non-homogeneous Poisson process of SESSIONS, intensity
//                L(t) = base * D(t) * B(t) * (1 + sum_i A_i exp(-(t - t_i)/tau_i)) * N(bin(t))
//              D  daily wave (shared with faultlab's load coupling)       B  two-state burst process (MMPP)
//              flash crowds: Poisson arrivals, instant jump A_i, exponential decay    N  lognormal noise per 5 s bin
//              realised by Lewis-Shedler thinning against a cap, so it is OPEN-LOOP: a slow system does not slow the arrivals.
//   sessions   a Markov chain over pages, lognormal think times between steps, Zipf product popularity, new vs returning users.
import crypto from 'node:crypto';

export function makeRng(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  let a = h.readUInt32LE(0) >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return {
    u, normal,
    exp: (mean) => -mean * Math.log(1 - u()),
    range: (lo, hi) => lo + (hi - lo) * u(),
    int: (n) => Math.floor(u() * n),
    lognormal: (median, sigma) => median * Math.exp(sigma * normal()),
    pick: (table) => { // {name: weight}
      const entries = Object.entries(table); const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = u() * total; for (const [k, w] of entries) { if ((r -= w) < 0) return k; } return entries[entries.length - 1][0];
    },
  };
}

/** Daily wave in [0.1, 1.0]; identical to faultlab's diurnal() so faults and load can be coupled. */
export const diurnal = (tSec, periodSec) => 0.55 + 0.45 * Math.sin((2 * Math.PI * tSec) / periodSec);

export const DEFAULT_PROFILE = {
  baseRps: 0.6,                      // sessions per second at D = 1 and no burst
  periodSec: 1800,                   // one "day"
  burst: { mult: 2.2, upMeanSec: 40, downMeanSec: 240 },   // MMPP: calm most of the time, brief busy spells
  flash: { ratePerHour: 3, amp: [1.5, 4], tau: [45, 180] },
  noiseSigma: 0.12,
  capMult: 14,                       // thinning cap, in multiples of baseRps
};

/** Time-varying session rate. Query it with non-decreasing t (the arrival loop does). */
export class RateModel {
  constructor(seed, profile = {}) {
    this.p = { ...DEFAULT_PROFILE, ...profile, burst: { ...DEFAULT_PROFILE.burst, ...profile.burst }, flash: { ...DEFAULT_PROFILE.flash, ...profile.flash } };
    this.seed = seed;
    this.rng = makeRng(`${seed}|rate`);
    this.inBurst = false; this.nextSwitch = this.rng.exp(this.p.burst.downMeanSec);
    this.flashes = []; this.nextFlash = this.rng.exp(3600 / this.p.flash.ratePerHour);
    this.noise = new Map();
    this.cap = this.p.baseRps * this.p.capMult;
  }
  burstFactor(t) { while (t >= this.nextSwitch) { this.inBurst = !this.inBurst; this.nextSwitch += this.rng.exp(this.inBurst ? this.p.burst.upMeanSec : this.p.burst.downMeanSec); } return this.inBurst ? this.p.burst.mult : 1; }
  flashFactor(t) {
    while (t >= this.nextFlash) { this.flashes.push({ t0: this.nextFlash, a: this.rng.range(...this.p.flash.amp), tau: this.rng.range(...this.p.flash.tau) }); this.nextFlash += this.rng.exp(3600 / this.p.flash.ratePerHour); }
    this.flashes = this.flashes.filter((f) => t - f.t0 < 6 * f.tau);
    return 1 + this.flashes.reduce((s, f) => s + (t >= f.t0 ? f.a * Math.exp(-(t - f.t0) / f.tau) : 0), 0);
  }
  noiseFactor(t) {
    const bin = Math.floor(t / 5);
    if (!this.noise.has(bin)) { this.noise.set(bin, Math.exp(this.p.noiseSigma * makeRng(`${this.seed}|n|${bin}`).normal())); if (this.noise.size > 400) this.noise.delete(this.noise.keys().next().value); }
    return this.noise.get(bin);
  }
  rate(t) { return Math.min(this.cap, this.p.baseRps * diurnal(t, this.p.periodSec) * this.burstFactor(t) * this.flashFactor(t) * this.noiseFactor(t)); }
}

/** Session start times (seconds), by thinning. Stops at horizonSec (default: never). */
export function* arrivals(model, rng, horizonSec = Infinity) {
  let t = 0;
  for (;;) {
    t += rng.exp(1 / model.cap);
    if (t >= horizonSec) return;
    if (rng.u() <= model.rate(t) / model.cap) yield t;
  }
}

// ---------------------------------------------------------------- sessions
/** Zipf(s) sampler over 1..n via an inverse-CDF table. */
export function zipf(n, s = 1.1) {
  const cdf = new Float64Array(n); let acc = 0;
  for (let k = 1; k <= n; k++) { acc += 1 / Math.pow(k, s); cdf[k - 1] = acc; }
  return (u) => { const x = u * acc; let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; } return lo + 1; };
}

/**
 * Walk a Markov chain of steps.
 *   chain = { start: {state: w}, states: { name: { run: async (c, session) => void, next: {state: w, exit: w} } } }
 * `c` is the loadgen context (http, user, rand); `session` is scratch space that persists across the steps of one visit.
 */
export async function walk(chain, c, rng, { thinkMs = 1500, maxSteps = 25, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const session = {};
  let state = rng.pick(chain.start);
  for (let i = 0; i < maxSteps && state && state !== 'exit'; i++) {
    const node = chain.states[state];
    try { await node.run(c, session); } catch { /* a failed step ends nothing: the visitor just carries on */ }
    const next = rng.pick(node.next);
    if (next === 'exit') break;
    await sleep(Math.min(20000, rng.lognormal(thinkMs, 0.8)));
    state = next;
  }
}

/** Returning visitors (Zipf over the user base) or brand new ones. */
export function userPicker(rng, population, returning = 0.6) {
  const z = zipf(population, 1.0); let fresh = population;
  return () => (rng.u() < returning ? `u${z(rng.u()) - 1}` : `u${fresh++}`);
}
