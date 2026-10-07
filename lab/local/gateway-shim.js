// Docker-less stand-in for the nginx api-gateway: same routes, same JSON access-log shape.
// Only used by lab/local-stack.sh so the subjects can be exercised without Docker.
import http from 'node:http';
import fs from 'node:fs';
const routes = JSON.parse(process.env.ROUTES); // [{prefix, rewrite:[re, replacement], upstream}]
const logFile = process.env.ACCESS_LOG ? fs.createWriteStream(process.env.ACCESS_LOG, { flags: 'a' }) : process.stdout;
const timeout = Number(process.env.READ_TIMEOUT_MS ?? 10000);
http.createServer((req, res) => {
  const start = process.hrtime.bigint();
  const r = routes.find((x) => req.url.startsWith(x.prefix));
  const done = (status, up, upStatus, upTime) => logFile.write(JSON.stringify({
    timestamp: new Date().toISOString(), method: req.method, uri: req.url.split('?')[0], request: `${req.method} ${req.url} HTTP/1.1`,
    status: String(status), body_bytes_sent: '0', request_time: (Number(process.hrtime.bigint() - start) / 1e9).toFixed(3),
    upstream_addr: up ?? '-', upstream_status: upStatus ?? '-', upstream_response_time: upTime ?? '-' }) + '\n');
  if (!r) { res.writeHead(404).end(); return done(404); }
  const path = req.url.replace(new RegExp(r.rewrite[0]), r.rewrite[1]);
  const u = new URL(r.upstream);
  const preq = http.request({ host: u.hostname, port: u.port, path, method: req.method, headers: { ...req.headers, host: u.host } }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers); pres.pipe(res);
    pres.on('end', () => done(pres.statusCode, u.host, pres.statusCode, (Number(process.hrtime.bigint() - start) / 1e9).toFixed(3)));
  });
  preq.setTimeout(timeout, () => preq.destroy(new Error('timeout')));
  preq.on('error', (e) => { const s = e.message === 'timeout' ? 504 : 502; if (!res.headersSent) res.writeHead(s).end(); done(s, u.host, s); });
  req.pipe(preq);
}).listen(Number(process.env.PORT ?? 8080), () => console.log('gateway-shim up'));
