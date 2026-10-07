#!/usr/bin/env node
// Checks a running observability stack end to end:  node lab/verify-observability.mjs <shopflow|ledgerline> [--grafana http://localhost:3000] [--prom http://localhost:9090]
//  1. Prometheus: every scrape target is up           2. Grafana: datasources healthy, dashboard provisioned
//  3. Every dashboard panel's query is executed against Prometheus/Loki and must parse; panels that legitimately stay empty on a healthy system
//     (5xx, 4xx, error logs, restarts, circuit-open) are reported as "empty (expected when healthy)", anything else empty is a FAIL.
import fs from 'node:fs';
import path from 'node:path';
const subject = process.argv[2];
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const GRAFANA = opt('grafana', 'http://localhost:3000'), PROM = opt('prom', 'http://localhost:9090');   // Loki is reached through Grafana's datasource proxy (it is not published)
const auth = 'Basic ' + Buffer.from(`admin:${process.env.GRAFANA_PASSWORD ?? 'bench'}`).toString('base64');
const j = async (url, init) => (await fetch(url, { signal: AbortSignal.timeout(15000), ...init })).json();
let fails = 0; const ok = (m) => console.log(`  ok    ${m}`), bad = (m) => (fails++, console.log(`  FAIL  ${m}`));

console.log('prometheus targets');
const t = (await j(`${PROM}/api/v1/targets`)).data.activeTargets;
for (const x of t) (x.health === 'up' ? ok : bad)(`${x.labels.job} ${x.health}${x.lastError ? ' - ' + x.lastError : ''}`);

console.log('grafana');
for (const ds of ['prom', 'loki']) {
  try { const h = await j(`${GRAFANA}/api/datasources/uid/${ds}/health`, { headers: { authorization: auth } }); (h.status === 'OK' ? ok : bad)(`datasource ${ds}: ${h.status ?? h.message}`); }
  catch (e) { bad(`datasource ${ds}: ${e.message}`); }
}
const dash = await j(`${GRAFANA}/api/dashboards/uid/bench`, { headers: { authorization: auth } }).catch(() => null);
dash?.dashboard ? ok(`dashboard "${dash.dashboard.title}" provisioned (${dash.dashboard.panels.length} panels)`) : bad('dashboard "bench" not provisioned');

console.log('panel queries (executed against the datasources)');
const local = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', subject, 'observability/grafana/dashboards/bench.json'), 'utf8'));
const EXPECT_EMPTY = /5\.\.|4\.\.|error|fatal|warn|Restarts|circuit|Client errors|Error rate|Error log|Warnings/i;
for (const p of local.panels) {
  for (const tg of p.targets ?? []) {
    try {
      const r = p.datasource.uid === 'loki'
        ? (p.type === 'logs' ? await j(`${GRAFANA}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(tg.expr)}&limit=5`, { headers: { authorization: auth } }) : await j(`${GRAFANA}/api/datasources/proxy/uid/loki/loki/api/v1/query?query=${encodeURIComponent(tg.expr)}`, { headers: { authorization: auth } }))
        : await j(`${PROM}/api/v1/query?query=${encodeURIComponent(tg.expr)}`);
      if (r.status !== 'success') { bad(`${p.title}: ${r.error ?? 'query failed'}`); continue; }
      const n = r.data.result.length;
      if (n > 0) ok(`${p.title}: ${n} series`);
      else if (EXPECT_EMPTY.test(p.title)) ok(`${p.title}: empty (expected when healthy)`);
      else bad(`${p.title}: no data  [${tg.expr.slice(0, 90)}]`);
    } catch (e) { bad(`${p.title}: ${e.message}`); }
  }
}
console.log(fails ? `\n${fails} failure(s)` : '\nobservability stack verified');
process.exit(fails ? 1 : 0);
