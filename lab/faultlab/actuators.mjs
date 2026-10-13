// faultlab/actuators.mjs: how each fault class is applied to a container. All faults are PHYSICAL (signals, cgroup limits,
// network attachment) and applied from the host with the docker CLI. Nothing is installed in, labelled on or written into
// the system under test, so the only thing a monitoring tool can see is the fault's effect.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
const pexec = promisify(execFile);

export function makeDocker({ project, network, composeFile = null }) {
  let prefix = null;                                              // 'docker' or 'sudo docker', decided once
  const run = async (args, { tolerate = false } = {}) => {
    if (prefix === null) {
      try { await pexec('docker', ['info'], { timeout: 15000 }); prefix = ['docker']; } catch { prefix = ['sudo', 'docker']; }
    }
    try { return (await pexec(prefix[0], [...prefix.slice(1), ...args], { timeout: 60000 })).stdout.trim(); }
    catch (e) { if (tolerate) return ''; throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`); }
  };
  const container = async (svc) => (await run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${svc}`])).split('\n')[0] || null;

  const inspect = async (c) => JSON.parse(await run(['inspect', c]))[0];
  const state = async (svc) => {
    const c = await container(svc); if (!c) return 'missing';
    const i = await inspect(c), s = i.State;
    if (s.Paused) return 'paused';
    if (!s.Running) return s.Status;
    if (!i.NetworkSettings.Networks?.[network]) return 'detached';
    if (s.Health?.Status === 'unhealthy') return 'unhealthy';
    return 'ok';
  };
  const bytes = (txt) => { const m = /([\d.]+)\s*([KMG]i?B|B)/i.exec(txt); if (!m) return 0; const k = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 }[m[2].toLowerCase()]; return Number(m[1]) * k; };

  // Everything a fault changes is remembered first so healing restores the ORIGINAL configuration, not a guess.
  const originals = new Map();
  const remember = async (svc, c) => {
    if (originals.has(svc)) return originals.get(svc);
    const h = (await inspect(c)).HostConfig;
    const o = { cpus: (h.NanoCpus || 0) / 1e9, memory: h.Memory || 0, swap: h.MemorySwap || 0 };
    originals.set(svc, o); return o;
  };
  // `docker update --cpus 0` is silently ignored by the daemon, so "no limit" is restored as "all of the host's cores",
  // which has the same effect on the container's cgroup.
  // The compose file is the source of truth for a service's limits; it survives across processes, unlike anything
  // remembered in memory, so a separate `heal` restores exactly what compose declared.
  let declared = null;
  const fromCompose = async () => {
    if (declared !== null) return declared;
    declared = {};
    if (!composeFile) return declared;
    try {
      const out = await run(['compose', '-p', project, '-f', composeFile, 'config', '--format', 'json']);
      for (const [name, v] of Object.entries(JSON.parse(out).services ?? {})) declared[name] = { cpus: Number(v.cpus || 0), memory: Number(v.mem_limit || 0), swap: Number(v.memswap_limit || 0) };
    } catch { /* no compose available: fall back to what was remembered */ }
    return declared;
  };
  const restoreResources = async (svc, c) => {
    const o = (await fromCompose())[svc] ?? originals.get(svc) ?? { cpus: 0, memory: 0, swap: 0 };
    await run(['update', '--cpus', String(o.cpus || os.cpus().length), c], { tolerate: true });
    if (o.memory) await run(['update', '--memory', String(o.memory), '--memory-swap', String(o.swap || o.memory * 2), c], { tolerate: true });
  };
  const attach = async (svc, c, { strict = false } = {}) => {
    const nets = (await inspect(c)).NetworkSettings.Networks ?? {};
    if (!nets[network]) await run(['network', 'connect', '--alias', svc, network, c], { tolerate: !strict });
  };

  /** Put a service back exactly as it was. Safe to call on a healthy one. Returns the state it ended in, so a failed
   *  heal is reported instead of hidden. */
  const heal = async (svc) => {
    const c = await container(svc); if (!c) return 'missing';
    await run(['unpause', c], { tolerate: true });
    await run(['start', c], { tolerate: true });
    await restoreResources(svc, c);
    try { await attach(svc, c, { strict: true }); } catch (e) { return `detached (${e.message})`; }
    return state(svc);
  };

  // Each class: start() applies it, during(ctx) lasts for the fault's duration, end() reverts it. A class with nothing to hold
  // (crash) has no during(). `ctx.sleep(sec)` is abortable and honours the campaign's speed-up.
  const classes = {
    crash: (svc, c) => ({
      start: async () => { await stable(c); await run(['kill', c]); },
      during: async (ctx) => { ctx.out.recovery = await recover(svc, c, 25); },
      end: async () => {},
    }),
    'crash-loop': (svc, c, ev) => ({
      start: async () => { await stable(c); await run(['kill', c]); },
      during: async (ctx) => {
        for (let i = 1; i < ev.kills; i++) {
          await ctx.sleep(ev.gapSec);
          if ((await state(svc)) === 'ok') await run(['kill', c], { tolerate: true });   // killed again as it comes back
          else await recover(svc, c, 4);
        }
      },
      end: async (ctx) => { if (ctx) ctx.out.recovery = await recover(svc, c, 25); },
    }),
    stop:  (svc, c, ev) => ({ start: () => run(['stop', '-t', '1', c]), during: (ctx) => ctx.sleep(ev.durationSec), end: () => run(['start', c], { tolerate: true }) }),
    pause: (svc, c, ev) => ({ start: () => run(['pause', c]), during: (ctx) => ctx.sleep(ev.durationSec), end: () => run(['unpause', c], { tolerate: true }) }),
    brownout: (svc, c, ev) => ({
      start: async () => { await remember(svc, c); if (!ev.rampSec) await run(['update', '--cpus', String(quota(ev.severity)), c]); },
      during: async (ctx) => {
        if (!ev.rampSec) return ctx.sleep(ev.durationSec);
        const steps = 6, target = quota(ev.severity);
        for (let i = 1; i <= steps; i++) { await run(['update', '--cpus', String(+(1 - (1 - target) * (i / steps)).toFixed(3)), c], { tolerate: true }); await ctx.sleep(ev.rampSec / steps); }
        await ctx.sleep(Math.max(0, ev.durationSec - ev.rampSec));
      },
      end: () => restoreResources(svc, c),
    }),
    memory: (svc, c, ev) => ({
      start: async () => {
        await remember(svc, c);
        const used = bytes(await run(['stats', '--no-stream', '--format', '{{.MemUsage}}', c]));
        // The kernel refuses a limit below what the container already holds, so squeeze to just above its working set:
        // the more severe, the tighter, so any growth then reclaims hard or gets the process OOM-killed.
        let limit = Math.max(Math.round(used * (1.03 + 0.15 * (1 - ev.severity))), Math.round(used) + 3 * 1048576);
        for (let tryNo = 0; ; tryNo++) {
          try { await run(['update', '--memory', String(limit), '--memory-swap', String(limit), c]); break; }
          catch (e) { if (tryNo >= 3) throw e; limit += 3 * 1048576; }
        }
      },
      during: (ctx) => ctx.sleep(ev.durationSec),
      end: () => restoreResources(svc, c),
    }),
    partition: (svc, c, ev) => ({ start: () => run(['network', 'disconnect', network, c]), during: (ctx) => ctx.sleep(ev.durationSec), end: () => attach(svc, c) }),
    flap: (svc, c, ev) => ({
      start: async () => {},
      during: async (ctx) => {
        const t0 = Date.now();
        while ((Date.now() - t0) / 1000 * (ctx.speed ?? 1) < ev.durationSec && !ctx.signal.aborted) {
          await run(['pause', c], { tolerate: true }); await ctx.sleep(ev.periodSec * ev.duty);
          await run(['unpause', c], { tolerate: true }); await ctx.sleep(ev.periodSec * (1 - ev.duty));
        }
      },
      end: () => run(['unpause', c], { tolerate: true }),
    }),
  };
  const quota = (sev) => Math.max(0.05, +(1 - 0.95 * sev).toFixed(3));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Docker only honours a restart policy for a container that has been up ~10 s, so a crash is never aimed at a fresh one. */
  const stable = async (c) => {
    const started = Date.parse((await inspect(c)).State.StartedAt);
    const wait = 12000 - (Date.now() - started);
    if (wait > 0) await nap(wait);
  };
  /** Wait for the restart policy to bring the service back; if it has not within graceSec, start it (as an orchestrator would)
   *  and say so. Returns how it came back. */
  const recover = async (svc, c, graceSec) => {
    const t0 = Date.now();
    for (;;) {
      if ((await state(svc)) === 'ok') return `restart-policy (${Math.round((Date.now() - t0) / 1000)}s)`;
      if ((Date.now() - t0) / 1000 > graceSec) break;
      await nap(1000);
    }
    await run(['start', c], { tolerate: true });
    for (let i = 0; i < 60; i++) { if ((await state(svc)) === 'ok') return `manual-start-after-${graceSec}s`; await nap(1000); }
    return 'did-not-recover';
  };

  /** Whole lifecycle of one fault; always reverts, even if the hold is aborted or something throws. */
  const execute = async (ev, ctx, { hold = false } = {}) => {
    const c = await container(ev.target);
    if (!c) throw new Error(`no container for ${ev.target}`);
    const f = classes[ev.class]?.(ev.target, c, ev);
    if (!f) throw new Error(`unknown fault class ${ev.class}`);
    const out = {};
    const cx = { ...ctx, out };
    let applied = false;
    try {
      await f.start(); applied = true; out.appliedAt = Date.now();
      if (hold) return out;
      if (f.during) await f.during(cx);
    } finally {
      if (!hold || !applied) { await f.end(cx).catch(() => {}); out.healedAt = Date.now(); }
    }
    return out;
  };

  return { run, container, state, heal, execute, quota };
}
