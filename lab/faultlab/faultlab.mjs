#!/usr/bin/env node
// faultlab: organic, reproducible, mapper-blind fault injection for a bench. Run it ON the bench host (needs docker).
//
//   node lab/faultlab/faultlab.mjs <subject> <command> [options]          subject: shopflow | ledgerline
//
//   list                         services, roles, dependencies and what each fault class does
//   plan                         print the campaign a seed would produce (no docker, nothing touched)
//   run                          execute a campaign in real time (Ctrl-C heals everything first)
//   inject <service> <class>     apply ONE fault by hand, hold it for its duration, heal
//   heal [service]               put everything (or one service) back exactly as it was
//   status                       state of every service, and any campaign that is running
//
// campaign options:  --profile gentle|realistic|stormy   --seed <text>   --duration 90m|2h|3600   --speed 1   (>1 compresses time)
//   --classes crash,pause,...  --targets cart,orders   --max-concurrent N  --rate-per-min X  --compound P  --cooldown S
//   --blast B  --coupling K  --period-min 30  --blind (operator sees nothing; read the ledger afterwards)  --dry-run  --json
// manual options:    --for 60s  --severity 0.7  --ramp 30  --period 10  --duty 0.5  --hold (leave it on until `heal`)
//
// MAPPER-BLIND: faults are signals, cgroup limits and network attachment applied from the host. Nothing is labelled, installed
// or logged inside the system under test. The plan, the seed and the ground truth exist only in the ledger on this host:
// ~/.faultlab/ledger-<subject>.jsonl (override with --ledger or FAULTLAB_LEDGER).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planCampaign, CLASSES, PROFILES, ROLE_MULT, downstreamOf } from './engine.mjs';
import { makeDocker } from './actuators.mjs';

const argv = process.argv.slice(2);
const subject = argv[0];
const cmd = argv[1] ?? 'list';
const rest = argv.slice(2);
const flags = new Set(['blind', 'dry-run', 'json', 'hold']);
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); if (flags.has(k)) opts[k] = true; else opts[k] = rest[++i]; } else pos.push(rest[i]);
}
const secs = (v, d) => { if (v === undefined) return d; const m = /^([\d.]+)\s*(s|m|h)?$/i.exec(String(v)); if (!m) throw new Error(`bad duration "${v}"`); return Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[(m[2] ?? 's').toLowerCase()]); };
const num = (v, d) => (v === undefined ? d : Number(v));

const here = path.dirname(new URL(import.meta.url).pathname);
const catalogFile = path.join(here, `catalog.${subject}.json`);
if (!subject || !fs.existsSync(catalogFile)) { console.error('usage: faultlab.mjs <shopflow|ledgerline> <list|plan|run|inject|heal|status> [options]'); process.exit(2); }
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const dir = path.join(os.homedir(), '.faultlab');
const ledgerPath = opts.ledger ?? process.env.FAULTLAB_LEDGER ?? path.join(dir, `ledger-${subject}.jsonl`);
const activePath = path.join(dir, `active-${subject}.json`);
const docker = makeDocker({ project: catalog.project, network: catalog.network, composeFile: catalog.compose ? path.resolve(here, '..', '..', catalog.compose) : null });
const services = Object.keys(catalog.services);

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const ledger = (rec) => { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.appendFileSync(ledgerPath, JSON.stringify({ ts: Date.now(), subject, ...rec }) + '\n', { mode: 0o600 }); };
const pad = (s, n) => String(s).padEnd(n);

function profileFromOptions() {
  const base = { ...PROFILES[opts.profile ?? 'realistic'] };
  if (!base.ratePerMin && base.ratePerMin !== 0) throw new Error(`unknown profile ${opts.profile}`);
  if (opts['rate-per-min']) base.ratePerMin = num(opts['rate-per-min']);
  if (opts['max-concurrent']) base.maxConcurrent = num(opts['max-concurrent']);
  if (opts.compound) base.compoundProb = num(opts.compound);
  if (opts.cooldown) base.cooldownSec = secs(opts.cooldown);
  if (opts.blast) base.blastBudget = num(opts.blast);
  if (opts.coupling) base.loadCoupling = num(opts.coupling);
  return base;
}
const campaign = () => {
  const seed = opts.seed ?? crypto.randomBytes(6).toString('hex');
  const horizonSec = secs(opts.duration, 3600);
  const only = { classes: opts.classes?.split(','), targets: opts.targets?.split(',') };
  for (const c of only.classes ?? []) if (!CLASSES[c]) throw new Error(`unknown fault class ${c} (${Object.keys(CLASSES).join(', ')})`);
  for (const t of only.targets ?? []) if (!catalog.services[t]) throw new Error(`unknown service ${t}`);
  const profile = profileFromOptions();
  const periodSec = secs(opts['period-min'] ? `${opts['period-min']}m` : undefined, 1800);
  const { events, stats } = planCampaign({ catalog, profile, seed, horizonSec, periodSec, only });
  return { seed, horizonSec, profile, periodSec, events, stats };
};

const describe = (e) => {
  const bits = [];
  if (e.severity !== undefined) bits.push(`severity ${e.severity}`);
  if (e.rampSec) bits.push(`ramp ${e.rampSec}s`);
  if (e.kills) bits.push(`${e.kills} kills every ${e.gapSec}s`);
  if (e.periodSec) bits.push(`${e.periodSec}s period, ${Math.round(e.duty * 100)}% frozen`);
  if (e.compoundOf) bits.push(`follows ${e.compoundOf}`);
  return bits.join(', ');
};
const mmss = (t) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- commands
async function list() {
  const { reach } = downstreamOf(catalog);
  console.log(`${subject}: ${services.length} services (entry ${catalog.entry})\n`);
  console.log(pad('service', 20), pad('role', 10), pad('hazard', 7), 'depends on  =>  breaks if it fails');
  for (const s of services) {
    const v = catalog.services[s];
    console.log(pad(s, 20), pad(v.role, 10), pad(v.protected ? '-' : v.hazard, 7), `${(v.deps ?? []).join(', ') || '-'}  =>  ${[...reach.get(s)].join(', ') || '-'}${v.protected ? '  (never faulted)' : ''}`);
  }
  console.log('\nfault classes:');
  for (const [c, v] of Object.entries(CLASSES)) console.log(' ', pad(c, 11), pad(`w=${v.weight}`, 8), v.desc, v.dur ? `[median ${v.dur.median}s, ${v.dur.min}-${v.dur.max}s]` : '');
  console.log('\nprofiles:', Object.entries(PROFILES).map(([n, p]) => `${n} (${p.ratePerMin}/min, <=${p.maxConcurrent} at once, compound ${p.compoundProb})`).join('; '));
}

async function plan() {
  const c = campaign();
  if (opts.json) return console.log(JSON.stringify(c, null, 2));
  console.log(`seed ${c.seed}, ${c.events.length} faults in ${mmss(c.horizonSec)} (expected ~${c.stats.expectedArrivals}, ${c.stats.blocked} blocked by limits)\n`);
  for (const e of c.events) console.log(mmss(e.at), pad(e.id, 5), pad(e.class, 11), pad(e.target, 18), pad(`${e.durationSec}s`, 6), describe(e), `-> affects ${e.truth.expectedAffected.length}`);
}

async function status() {
  for (const s of services) console.log(pad(s, 20), await docker.state(s));
  if (fs.existsSync(activePath)) console.log('\nactive:', fs.readFileSync(activePath, 'utf8'));
}

async function healAll() {
  if (fs.existsSync(activePath)) {
    try { const a = JSON.parse(fs.readFileSync(activePath, 'utf8')); if (a.pid && a.pid !== process.pid) process.kill(a.pid, 'SIGTERM'); } catch { /* not running */ }
  }
  let bad = 0;
  for (const s of (pos[0] ? [pos[0]] : services)) { const st = await docker.heal(s); if (st !== 'ok') { bad++; console.error(`  ${s}: still ${st}`); } }
  if (!pos[0]) fs.rmSync(activePath, { force: true });
  console.log(bad ? `healed with ${bad} service(s) not back to normal (see above)` : `healed ${pos[0] ?? 'everything'}`);
  if (bad) process.exitCode = 1;
}

/** Wait helpers that honour the speed-up and can be cut short by a signal. */
function makeCtx(speed, signal) {
  const sleep = (sec) => new Promise((resolve) => {
    const t = setTimeout(resolve, (sec * 1000) / speed);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  return { sleep, signal, speed };
}

async function runEvent(ev, ctx, { hold = false } = {}) {
  const startedAt = Date.now();
  const params = { id: ev.id, class: ev.class, target: ev.target, durationSec: ev.durationSec, severity: ev.severity, rampSec: ev.rampSec, kills: ev.kills, gapSec: ev.gapSec, periodSec: ev.periodSec, duty: ev.duty, compoundOf: ev.compoundOf, source: ev.source, truth: ev.truth };
  ledger({ type: 'fault-start', ...params, plannedAt: ev.at, startedAt });
  let res = {}, error;
  try { res = await docker.execute(ev, ctx, { hold }); } catch (e) { error = e.message; await docker.heal(ev.target).catch(() => {}); }
  ledger({ type: 'fault-end', id: ev.id, target: ev.target, class: ev.class, ...res, endedAt: Date.now(), held: hold || undefined, error });
  return { error, res };
}

async function run() {
  const c = campaign();
  const speed = num(opts.speed, 1);
  if (opts['dry-run']) return plan();
  if (!opts.blind) console.log(`campaign ${c.seed}: ${c.events.length} faults over ${mmss(c.horizonSec / speed)} (profile ${opts.profile ?? 'realistic'}, speed x${speed}); ledger ${ledgerPath}`);
  else console.log(`blind campaign running for ${mmss(c.horizonSec / speed)}; the plan is only in the ledger (${ledgerPath})`);
  if (!opts.blind) for (const e of c.events) console.log(' ', mmss(e.at), pad(e.id, 5), pad(e.class, 11), pad(e.target, 18), describe(e));
  ledger({ type: 'campaign-start', seed: c.seed, profile: c.profile, horizonSec: c.horizonSec, periodSec: c.periodSec, speed, plan: c.events });
  fs.writeFileSync(activePath, JSON.stringify({ pid: process.pid, seed: c.seed, startedAt: Date.now() }), { mode: 0o600 });

  const ac = new AbortController();
  const stop = () => ac.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const stopFile = path.join(dir, 'STOP');
  const watchdog = setInterval(() => { if (fs.existsSync(stopFile)) { fs.rmSync(stopFile); stop(); } }, 1000);
  const ctx = makeCtx(speed, ac.signal);
  const running = [];
  const t0 = Date.now();
  for (const ev of c.events) {
    const wait = (ev.at * 1000) / speed - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => { const t = setTimeout(r, wait); ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    if (ac.signal.aborted) break;
    running.push(runEvent(ev, ctx).then((r) => { if (!opts.blind) console.log(`  ${mmss((Date.now() - t0) / 1000 * speed)} ${ev.id} ${ev.class} ${ev.target} ended${r.error ? ` (error: ${r.error})` : ''}`); }));
  }
  if (!ac.signal.aborted) await new Promise((r) => { const t = setTimeout(r, Math.max(0, (c.horizonSec * 1000) / speed - (Date.now() - t0))); ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  ac.abort();                                                     // wake any hold still sleeping; each fault reverts itself
  await Promise.all(running);
  for (const s of services) await docker.heal(s).catch(() => {});   // belt and braces
  clearInterval(watchdog); fs.rmSync(activePath, { force: true });
  ledger({ type: 'campaign-end', seed: c.seed, aborted: ac.signal.aborted && Date.now() - t0 < (c.horizonSec * 1000) / speed - 2000 });
  console.log(opts.blind ? 'campaign finished' : `campaign finished; ledger ${ledgerPath}`);
}

async function inject() {
  const [target, cls] = pos;
  if (!target || !cls) throw new Error('usage: inject <service> <class> [--for 60s] [--severity 0.7] [--ramp 30] [--period 10 --duty 0.5] [--hold]');
  if (!catalog.services[target]) throw new Error(`unknown service ${target} (try: list)`);
  const spec = CLASSES[cls]; if (!spec) throw new Error(`unknown class ${cls} (${Object.keys(CLASSES).join(', ')})`);
  const durationSec = Math.round(secs(opts.for, spec.dur?.median ?? spec.recoverySec ?? 60));
  const ev = {
    id: `m${Date.now().toString(36)}`, at: 0, class: cls, target, durationSec, source: 'manual',
    ...(spec.severity ? { severity: num(opts.severity, 0.7) } : {}),
    ...(opts.ramp ? { rampSec: secs(opts.ramp) } : {}),
    ...(cls === 'crash-loop' ? { kills: num(opts.kills, 4), gapSec: secs(opts.gap, 12) } : {}),
    ...(cls === 'flap' ? { periodSec: num(opts.period, 10), duty: num(opts.duty, 0.5) } : {}),
    truth: { rootCause: target, expectedAffected: [...downstreamOf(catalog).reach.get(target)].sort() },
  };
  if (opts.hold && (ev.rampSec || ['flap', 'crash-loop'].includes(cls))) throw new Error('--hold cannot be combined with ramps, flap or crash-loop (they need a running process)');
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort()); process.on('SIGTERM', () => ac.abort());
  console.log(`injecting ${cls} into ${target}${opts.hold ? ' and holding until `heal`' : ` for ${durationSec}s (Ctrl-C heals early)`}`);
  fs.writeFileSync(activePath, JSON.stringify({ pid: process.pid, manual: ev.id, target }), { mode: 0o600 });
  const r = await runEvent(ev, makeCtx(1, ac.signal), { hold: !!opts.hold });
  if (!opts.hold) fs.rmSync(activePath, { force: true });
  console.log(r.error ? `failed: ${r.error}` : opts.hold ? `applied; undo with: faultlab.mjs ${subject} heal ${target}` : 'healed');
  if (r.error) process.exitCode = 1;
}

try {
  await ({ list, plan, run, inject, heal: healAll, status }[cmd] ?? (() => { throw new Error(`unknown command ${cmd}`); }))();
} catch (e) { console.error(`faultlab: ${e.message}`); process.exit(1); }
void ROLE_MULT;
