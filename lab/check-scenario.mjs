#!/usr/bin/env node
// Score the mapper against a scenario's ground truth.
//   node lab/check-scenario.mjs --scenario shopflow/scenarios/sf-05-secret-rotation --target shopflow \
//        [--mapper http://localhost:3001] [--wait 180] [--interval 5]
// `--target` is the Target ID you gave the mapper when adding the project; node ids are "<target>:<service>".
// Polls /api/graph and /api/incidents for --wait seconds, then prints one PASS/FAIL line per expectation.
// Required expectations decide the exit code; scenarios marked `optional: true` are reported but never fail the run.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const mapper = opt('mapper', 'http://localhost:3001').replace(/\/$/, '');
const target = opt('target');
const scenarioDir = opt('scenario');
const waitS = Number(opt('wait', 180)), intervalS = Number(opt('interval', 5));
if (!target || !scenarioDir) { console.error('usage: --scenario <dir> --target <targetId> [--mapper url] [--wait s]'); process.exit(2); }
const spec = yaml.load(fs.readFileSync(path.join(scenarioDir, 'scenario.yaml'), 'utf8'));
const id = (s) => `${target}:${s}`;
const short = (s) => String(s ?? '').replace(`${target}:`, '');
const get = async (p) => (await fetch(mapper + p, { signal: AbortSignal.timeout(8000) })).json();

const seen = { observed: new Map(), declared: new Map(), unhealthy: new Set(), roots: new Set(), affected: new Set(), incidents: 0 };
const end = Date.now() + waitS * 1000;
console.log(`Watching ${mapper} for ${waitS}s (target "${target}", scenario ${spec.id})...`);
do {
  try {
    const g = await get('/api/graph');
    for (const e of g.edges ?? []) {
      const k = `${short(e.source)}->${short(e.target)}`;
      if (!e.source.startsWith(`${target}:`)) continue;
      seen.observed.set(k, seen.observed.get(k) || !!e.observed);
      seen.declared.set(k, seen.declared.get(k) || !!e.declared);
    }
    for (const n of g.nodes ?? []) if (n.project === target && n.status && n.status !== 'healthy' && n.status !== 'unknown') seen.unhealthy.add(short(n.id));
    const inc = await get(`/api/incidents?targetId=${encodeURIComponent(target)}`);
    for (const i of inc ?? []) {
      seen.incidents++;
      if (i.rootCauseServiceId) seen.roots.add(short(i.rootCauseServiceId));
      for (const a of i.affectedServices ?? i.explanation?.affectedServices ?? []) seen.affected.add(short(a));
    }
  } catch (e) { console.log(`  (poll failed: ${e.message})`); }
  await new Promise((r) => setTimeout(r, intervalS * 1000));
} while (Date.now() < end);

const rows = [];
const check = (name, ok, detail = '', optional = false) => rows.push({ name, ok, detail, optional });
for (const e of spec.expect?.edges ?? []) {
  const k = `${e.source}->${e.target}`;
  const known = seen.declared.has(k);
  if (!known && e.observed === false && e.declared === true) check(`edge ${k} declared`, false, 'edge not in graph at all (declared edge should exist)');
  else {
    check(`edge ${k} declared=${e.declared}`, (seen.declared.get(k) ?? false) === e.declared, `graph: ${seen.declared.get(k) ?? 'absent'}`);
    check(`edge ${k} observed=${e.observed}`, (seen.observed.get(k) ?? false) === e.observed, `graph: ${seen.observed.get(k) ?? 'absent'}`);
  }
}
for (const n of spec.expect?.nodes_unhealthy_at_some_point ?? []) check(`${n} became unhealthy`, seen.unhealthy.has(n), `unhealthy seen: [${[...seen.unhealthy].join(', ')}]`, spec.expect?.incident?.optional);
const inc = spec.expect?.incident;
if (inc === null) check('no incident raised', seen.incidents === 0, `${seen.incidents} incident observations`);
else if (inc?.root_cause_any_of) check(`incident root cause in [${inc.root_cause_any_of.join(', ')}]`, inc.root_cause_any_of.some((r) => seen.roots.has(r)), `roots seen: [${[...seen.roots].join(', ')}]`, inc.optional);
let bad = 0;
for (const r of rows) {
  const tag = r.ok ? 'PASS' : r.optional ? 'MISS (optional)' : 'FAIL';
  if (!r.ok && !r.optional) bad++;
  console.log(`${tag.padEnd(16)} ${r.name}${r.detail ? `  -- ${r.detail}` : ''}`);
}
console.log(`\nGround truth: root cause = ${spec.ground_truth?.root_cause ?? 'none'}${spec.ground_truth?.symptomatic?.length ? `; symptomatic = ${spec.ground_truth.symptomatic.join(', ')}` : ''}`);
console.log(bad ? `${bad} required expectation(s) failed` : 'all required expectations met');
process.exit(bad ? 1 : 0);
