#!/usr/bin/env node
// Static consistency check -- needs only the `docker compose` CLI (no daemon). For every scenario it:
//   1. renders baseline + override with `docker compose config` (catches YAML / merge / anchor mistakes)
//   2. checks each scenario.yaml `expect.edges` against the REAL merged depends_on:
//        declared:true  -> the dependency must be present in compose
//        declared:false -> it must be absent (so "undeclared" scenarios cannot silently rot)
//   3. checks services named in the ground truth exist
//   4. checks every scenario has a compose override and a scenario.yaml
// Exit code 1 on any failure; run in CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '..');
let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };

for (const subject of ['shopflow', 'ledgerline'].filter((x) => fs.existsSync(path.join(root, x)))) {
  const dir = path.join(root, subject);
  const base = path.join(dir, 'docker-compose.yml');
  console.log(`\n${subject}`);
  for (const sc of fs.readdirSync(path.join(dir, 'scenarios')).sort()) {
    const sdir = path.join(dir, 'scenarios', sc);
    process.stdout.write(`- ${sc}\n`);
    const override = path.join(sdir, 'compose.override.yml');
    const spec = path.join(sdir, 'scenario.yaml');
    if (!fs.existsSync(override)) { fail('missing compose.override.yml'); continue; }
    if (!fs.existsSync(spec)) { fail('missing scenario.yaml'); continue; }
    let cfg;
    try {
      cfg = JSON.parse(execFileSync('docker', ['compose', '-f', base, '-f', override, '--profile', 'traffic', 'config', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }));
    } catch (e) { fail(`compose config: ${String(e.stderr ?? e.message).split('\n')[0]}`); continue; }
    const services = cfg.services;
    const declared = new Set(Object.entries(services).flatMap(([s, v]) => Object.keys(v.depends_on ?? {}).map((d) => `${s}->${d}`)));
    const doc = yaml.load(fs.readFileSync(spec, 'utf8'));
    for (const k of ['id', 'title', 'class', 'summary']) if (!doc[k]) fail(`scenario.yaml missing "${k}"`);
    if (doc.id !== sc) fail(`id "${doc.id}" != folder "${sc}"`);
    for (const e of doc.expect?.edges ?? []) {
      for (const end of [e.source, e.target]) if (!services[end]) fail(`edge ${e.source}->${e.target}: service "${end}" not in compose`);
      const has = declared.has(`${e.source}->${e.target}`);
      if (e.declared !== has) fail(`edge ${e.source}->${e.target}: scenario says declared=${e.declared}, compose says ${has}`);
    }
    for (const n of [doc.ground_truth?.root_cause, ...(doc.ground_truth?.symptomatic ?? [])].flat()) {
      if (typeof n === 'string' && /^[a-z][a-z0-9-]*$/.test(n) && !services[n]) fail(`ground truth names unknown service "${n}"`);
    }
    for (const n of doc.expect?.nodes_unhealthy_at_some_point ?? []) if (!services[n]) fail(`expect names unknown service "${n}"`);
  }
}
// ---- observability projects: compose renders, dashboard JSON parses, every Prometheus job maps to a service in the app compose
for (const subject of ['shopflow', 'ledgerline'].filter((x) => fs.existsSync(path.join(root, x)))) {
  console.log(`\n${subject} observability`);
  try {
    execFileSync('docker', ['compose', '-f', path.join(root, subject, 'docker-compose.obs.yml'), 'config', '-q'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const dash = JSON.parse(fs.readFileSync(path.join(root, subject, 'observability/grafana/dashboards/bench.json'), 'utf8'));
    const app = JSON.parse(execFileSync('docker', ['compose', '-f', path.join(root, subject, 'docker-compose.yml'), 'config', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).services;
    const prom = yaml.load(fs.readFileSync(path.join(root, subject, 'observability/prometheus.yml'), 'utf8'));
    for (const j of prom.scrape_configs) if (!['docker'].includes(j.job_name) && !app[j.job_name]) fail(`prometheus job "${j.job_name}" is not a service in the app compose`);
    console.log(`- compose ok, dashboard "${dash.title}" (${dash.panels.length} panels), ${prom.scrape_configs.length} scrape jobs`);
  } catch (e) { fail(`observability: ${String(e.stderr ?? e.message).split('\n')[0]}`); }
}
// ---- ecom-lab (third-party project pinned at a commit; only validated when ecom-lab/upstream has been fetched)
const up = path.join(root, 'ecom-lab', 'upstream');
console.log('\necom-lab');
if (!fs.existsSync(path.join(up, 'compose.yaml'))) console.log('- skipped (run ecom-lab/fetch.sh to enable)');
else for (const sc of fs.readdirSync(path.join(root, 'ecom-lab', 'scenarios')).sort()) {
  const sdir = path.join(root, 'ecom-lab', 'scenarios', sc);
  process.stdout.write(`- ${sc}\n`);
  const spec = path.join(sdir, 'scenario.yaml'), ovr = path.join(sdir, 'compose.override.yml');
  if (!fs.existsSync(spec)) { fail('missing scenario.yaml'); continue; }
  let cfg;
  try {
    const files = ['-f', 'compose.yaml', '-f', path.join(root, 'ecom-lab/overlays/no-es.yml'), '-f', path.join(root, 'ecom-lab/overlays/small.yml'), ...(fs.existsSync(ovr) ? ['-f', ovr] : [])];
    cfg = JSON.parse(execFileSync('docker', ['compose', ...files, 'config', '--format', 'json'], { cwd: up, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) { fail(`compose config: ${String(e.stderr ?? e.message).split('\n')[0]}`); continue; }
  const declared = new Set(Object.entries(cfg.services).flatMap(([n, v]) => Object.keys(v.depends_on ?? {}).map((d) => `${n}->${d}`)));
  const doc = yaml.load(fs.readFileSync(spec, 'utf8'));
  for (const k of ['id', 'title', 'class', 'summary']) if (!doc[k]) fail(`scenario.yaml missing "${k}"`);
  if (doc.id !== sc) fail(`id "${doc.id}" != folder "${sc}"`);
  const edges = [...(doc.expect?.edges ?? []), ...((doc.natural_findings ?? []).map((f) => f.expect).filter(Boolean))];
  for (const e of edges) {
    for (const end of [e.source, e.target]) if (!cfg.services[end]) fail(`edge ${e.source}->${e.target}: service "${end}" not in compose`);
    if (e.declared !== declared.has(`${e.source}->${e.target}`)) fail(`edge ${e.source}->${e.target}: scenario says declared=${e.declared}, compose says ${declared.has(`${e.source}->${e.target}`)}`);
  }
  for (const n of doc.expect?.nodes_unhealthy_at_some_point ?? []) if (!cfg.services[n]) fail(`expect names unknown service "${n}"`);
}
console.log(failures ? `\n${failures} failure(s)` : '\nall scenarios consistent');
process.exit(failures ? 1 : 0);
