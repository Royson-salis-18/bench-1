// docker-exporter: Prometheus metrics for every container of one compose project, straight from the Docker API (/var/run/docker.sock).
// Why not cAdvisor: it cannot map containers to names on newer Docker installs (containerd image store). This needs only the socket,
// reports the same numbers as `docker stats` (what the mapper's Tier 0 reads), and adds restart count, OOM flag, health and start time.
// Env: PROJECT (compose project to export, required), PORT (9200), INTERVAL_MS (5000).
import http from 'node:http';

const PROJECT = process.env.PROJECT;
if (!PROJECT) { console.error('PROJECT is required'); process.exit(1); }
const INTERVAL = Number(process.env.INTERVAL_MS ?? 5000);
const docker = (path) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: '/var/run/docker.sock', path, method: 'GET', timeout: 20000 }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('timeout', () => req.destroy(new Error('docker api timeout'))); req.on('error', reject); req.end();
});

let snapshot = [];
let lastOk = 0;
async function collect() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }));
  const list = await docker(`/containers/json?all=true&filters=${filters}`);
  snapshot = await Promise.all(list.map(async (c) => {
    const name = (c.Names[0] ?? '').replace(/^\//, '');
    const service = c.Labels['com.docker.compose.service'] ?? name;
    const info = await docker(`/containers/${c.Id}/json`).catch(() => null);
    const row = { name, service, running: c.State === 'running' ? 1 : 0, restarts: info?.RestartCount ?? 0, oom: info?.State?.OOMKilled ? 1 : 0,
      exit: info?.State?.ExitCode ?? 0, started: info?.State?.StartedAt ? Date.parse(info.State.StartedAt) / 1000 : 0,
      health: info?.State?.Health ? { healthy: 1, unhealthy: 0, starting: 2 }[info.State.Health.Status] ?? -1 : -1 };
    if (row.running) {
      const s = await docker(`/containers/${c.Id}/stats?stream=false`).catch(() => null);   // two samples inside the call, so precpu_stats is populated
      if (s?.cpu_stats) {
        const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats?.system_cpu_usage ?? 0);
        const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        row.cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;   // 100 = one core, like docker stats
        const cache = s.memory_stats.stats?.total_inactive_file ?? s.memory_stats.stats?.inactive_file ?? 0;
        row.mem = Math.max(0, (s.memory_stats.usage ?? 0) - cache); row.limit = s.memory_stats.limit ?? 0;
        row.rx = 0; row.tx = 0;
        for (const n of Object.values(s.networks ?? {})) { row.rx += n.rx_bytes; row.tx += n.tx_bytes; }
      }
    }
    return row;
  }));
  lastOk = Date.now();
}
async function loop() { try { await collect(); } catch (e) { console.error('collect failed:', e.message); } setTimeout(loop, INTERVAL); }
loop();

const HELP = {
  container_cpu_percent: ['gauge', 'CPU use, 100 = one core (as docker stats)'], container_memory_usage_bytes: ['gauge', 'working-set memory (usage minus inactive file cache)'],
  container_memory_limit_bytes: ['gauge', 'container memory limit (host RAM if unlimited)'], container_memory_percent: ['gauge', 'memory usage as % of the limit; only for containers with a limit below host RAM'],
  container_network_receive_bytes_total: ['counter', 'bytes received (all interfaces)'], container_network_transmit_bytes_total: ['counter', 'bytes sent (all interfaces)'],
  container_running: ['gauge', '1 if running'], container_restart_count: ['gauge', 'restarts performed by the docker restart policy'], container_oom_killed: ['gauge', '1 if the kernel OOM-killed the container'],
  container_exit_code: ['gauge', 'last exit code'], container_healthy: ['gauge', 'healthcheck: 1 healthy, 0 unhealthy, 2 starting, -1 none'], container_started_timestamp_seconds: ['gauge', 'last start time'],
};
function render() {
  const out = []; const lines = {};
  const add = (m, row, v) => { if (v === undefined || Number.isNaN(v)) return; (lines[m] ??= []).push(`${m}{name="${row.name}",service="${row.service}"} ${v}`); };
  for (const r of snapshot) {
    add('container_cpu_percent', r, r.cpu); add('container_memory_usage_bytes', r, r.mem); add('container_memory_limit_bytes', r, r.limit);
    if (r.limit && r.limit < 64 * 2 ** 30 && r.mem !== undefined && r.limit < 1e12) add('container_memory_percent', r, (r.mem / r.limit) * 100);
    add('container_network_receive_bytes_total', r, r.rx); add('container_network_transmit_bytes_total', r, r.tx);
    add('container_running', r, r.running); add('container_restart_count', r, r.restarts); add('container_oom_killed', r, r.oom);
    add('container_exit_code', r, r.exit); add('container_healthy', r, r.health); add('container_started_timestamp_seconds', r, r.started);
  }
  for (const [m, [type, help]] of Object.entries(HELP)) if (lines[m]) out.push(`# HELP ${m} ${help}`, `# TYPE ${m} ${type}`, ...lines[m]);
  out.push('# TYPE docker_exporter_last_success_timestamp_seconds gauge', `docker_exporter_last_success_timestamp_seconds ${lastOk / 1000}`);
  return out.join('\n') + '\n';
}
http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(Date.now() - lastOk < 4 * INTERVAL + 20000 ? 200 : 503).end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(render());
}).listen(Number(process.env.PORT ?? 9200), () => console.log(`docker-exporter for project "${PROJECT}" on :${process.env.PORT ?? 9200}`));
