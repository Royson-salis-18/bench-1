// Minimal Prometheus exposition: request-duration histogram using the OpenTelemetry
// semantic-convention name the mapper's Tier-2 source looks for first, plus a few
// process gauges. Prometheus' `job` label supplies the service name.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const hist = new Map(); // key -> {counts[], sum, count, labels}

export function observeRequest(method, route, status, seconds) {
  const key = `${method}|${route}|${status}`;
  let h = hist.get(key);
  if (!h) {
    h = { counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0, method, route, status };
    hist.set(key, h);
  }
  h.sum += seconds;
  h.count += 1;
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) h.counts[i] += 1;
}

const gauges = new Map();
export const setGauge = (name, help, value) => gauges.set(name, { help, value });

export function renderMetrics() {
  const mem = process.memoryUsage();
  setGauge('process_resident_memory_bytes', 'Resident memory', mem.rss);
  setGauge('nodejs_heap_used_bytes', 'V8 heap used', mem.heapUsed);
  const out = [
    '# HELP http_server_request_duration_seconds Server request duration',
    '# TYPE http_server_request_duration_seconds histogram',
  ];
  for (const h of hist.values()) {
    const l = `http_request_method="${h.method}",http_route="${h.route}",http_response_status_code="${h.status}"`;
    BUCKETS.forEach((b, i) => out.push(`http_server_request_duration_seconds_bucket{${l},le="${b}"} ${h.counts[i]}`));
    out.push(`http_server_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`);
    out.push(`http_server_request_duration_seconds_sum{${l}} ${h.sum}`);
    out.push(`http_server_request_duration_seconds_count{${l}} ${h.count}`);
  }
  for (const [name, g] of gauges) out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`, `${name} ${g.value}`);
  return out.join('\n') + '\n';
}
