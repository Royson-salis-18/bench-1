#!/usr/bin/env node
// faultlab panel: a small control page for the injector and the traffic generator. Run it ON the bench host.
//
//   node lab/faultlab/panel.mjs <shopflow|ledgerline> [--port 8099]
//   then open http://localhost:8099   (on EC2: ssh -L 8099:localhost:8099 ubuntu@<ip>, then the same URL on your laptop)
//
// It only starts the same commands you would type (faultlab.mjs and docker compose). It listens on 127.0.0.1 only,
// and it does not talk to the mapper: the mapper stays blind to everything done here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CLASSES, PROFILES } from './engine.mjs';

const subject = process.argv[2];
const pi = process.argv.indexOf('--port');
const port = pi > 0 ? Number(process.argv[pi + 1]) : 8099;
const here = path.dirname(new URL(import.meta.url).pathname);
const catFile = path.join(here, `catalog.${subject}.json`);
if (!subject || !fs.existsSync(catFile)) { console.error('usage: panel.mjs <shopflow|ledgerline> [--port 8099]'); process.exit(2); }
const catalog = JSON.parse(fs.readFileSync(catFile, 'utf8'));
const composeFile = path.resolve(here, '..', '..', subject, 'docker-compose.yml');
const cli = path.join(here, 'faultlab.mjs');

let campaign = null; // { proc, startedAt, args, log[] }
let trafficSettings = null; // last { baseRps, mode, at } applied from the panel
const logs = [];
const note = (s) => { logs.push(`${new Date().toISOString().slice(11, 19)} ${s}`); if (logs.length > 200) logs.shift(); };

function runCli(args) {
  note(`faultlab ${args.join(' ')}`);
  return new Promise((resolve) => {
    const p = spawn('node', [cli, subject, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { note(`-> exit ${code} ${out.trim().split('\n').slice(-2).join(' | ')}`); resolve({ code, out }); });
  });
}
const compose = (...a) => execFileSync('docker', ['compose', '-p', catalog.project, '-f', composeFile, '--profile', 'traffic', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function states() {
  try {
    const out = execFileSync('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${catalog.project}`, '--format', '{{.Label "com.docker.compose.service"}}\t{{.State}}'], { encoding: 'utf8' });
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')));
  } catch { return {}; }
}
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const list = (v) => (Array.isArray(v) ? v : []).filter((x) => /^[\w-]+$/.test(x));

const routes = {
  'GET /api/state': async () => {
    const st = states();
    return {
      subject, services: Object.entries(catalog.services).map(([name, s]) => ({ name, role: s.role, state: st[name] ?? 'absent' })),
      classes: Object.entries(CLASSES).map(([name, c]) => ({ name, desc: c.desc })), profiles: Object.keys(PROFILES),
      traffic: st.traffic ?? 'absent', trafficSettings, campaign: campaign ? { startedAt: campaign.startedAt, args: campaign.args } : null, log: logs.slice(-40),
    };
  },
  'POST /api/campaign': async (req) => {
    if (campaign) return { error: 'a campaign is already running' };
    const b = await body(req);
    const args = ['run', '--profile', PROFILES[b.profile] ? b.profile : 'realistic', '--duration', `${Math.max(1, Math.min(480, Number(b.minutes) || 30))}m`];
    const cl = list(b.classes), tg = list(b.targets);
    if (cl.length) args.push('--classes', cl.join(','));
    if (tg.length) args.push('--targets', tg.join(','));
    if (Number(b.ratePerMin) > 0) args.push('--rate-per-min', String(Number(b.ratePerMin)));
    if (Number(b.maxConcurrent) > 0) args.push('--max-concurrent', String(Math.floor(Number(b.maxConcurrent))));
    if (b.seed && /^[\w-]+$/.test(b.seed)) args.push('--seed', b.seed);
    note(`campaign: ${args.join(' ')}`);
    const proc = spawn('node', [cli, subject, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    campaign = { proc, startedAt: Date.now(), args: args.slice(1) };
    const tail = (d) => String(d).split('\n').filter(Boolean).forEach((l) => note(l.slice(0, 160)));
    proc.stdout.on('data', tail); proc.stderr.on('data', tail);
    proc.on('close', (c) => { note(`campaign ended (exit ${c})`); campaign = null; });
    return { ok: true };
  },
  'POST /api/stop': async () => {
    if (campaign) { campaign.proc.kill('SIGINT'); note('stopping: the campaign heals everything first'); } else await runCli(['heal']);
    return { ok: true };
  },
  'POST /api/inject': async (req) => {
    const b = await body(req);
    if (!catalog.services[b.service] || !CLASSES[b.class]) return { error: 'unknown service or class' };
    const args = ['inject', b.service, b.class, '--for', `${Math.max(5, Math.min(1800, Number(b.seconds) || 60))}s`, '--severity', String(Math.min(1, Math.max(0.1, Number(b.severity) || 0.8)))];
    runCli(args); return { ok: true };
  },
  'POST /api/heal': async (req) => { const b = await body(req); await runCli(['heal', ...(catalog.services[b.service] ? [b.service] : [])]); return { ok: true }; },
  'POST /api/traffic': async (req) => {
    const b = await body(req);
    try {
      if (b.action === 'stop') compose('stop', 'traffic');
      else {
        const env = { ...process.env };
        if (Number(b.baseRps) > 0) env.TRAFFIC_BASE_RPS = String(Number(b.baseRps));
        if (['organic', 'steady'].includes(b.mode)) env.TRAFFIC_MODE = b.mode;
        execFileSync('docker', ['compose', '-p', catalog.project, '-f', composeFile, '--profile', 'traffic', 'up', '-d', '--force-recreate', 'traffic'], { env, stdio: 'pipe' });
        trafficSettings = { baseRps: env.TRAFFIC_BASE_RPS ?? null, mode: env.TRAFFIC_MODE ?? null, at: Date.now() };
      }
      note(`traffic ${b.action}${b.baseRps ? ` base ${b.baseRps} rps` : ''}${b.mode ? ` ${b.mode}` : ''}`);
      return { ok: true };
    } catch (e) { return { error: String(e.stderr || e.message).slice(0, 300) }; }
  },
};

const PAGE = fs.readFileSync(path.join(here, 'panel.html'), 'utf8');
http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  if (key === 'GET /') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const h = routes[key];
  if (!h) { res.writeHead(404); return res.end(); }
  if (req.method === 'POST' && req.headers['x-panel'] !== '1') { res.writeHead(403); return res.end(); }
  try { const out = await h(req); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
  catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(port, '127.0.0.1', () => console.log(`faultlab panel for ${subject}: http://localhost:${port}`));
