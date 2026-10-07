import { log } from './log.js';

/** Retry a startup dependency (DB, broker). Exits non-zero when the budget is spent so the
 *  orchestrator's restart policy takes over -- the standard crash-and-restart contract. */
export async function waitFor(name, fn, { retries, delayMs }) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      log.warn(`dependency ${name} not ready`, { attempt: i, of: retries, err: e.message });
      if (i >= retries) {
        log.fatal(`giving up on ${name}`, { err: e.message });
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** SIGTERM -> stop accepting, finish in-flight work, close pools, exit 0. */
export function onShutdown(fn) {
  let done = false;
  const handler = async (sig) => {
    if (done) return;
    done = true;
    log.info('shutting down', { sig });
    const t = setTimeout(() => process.exit(1), 10000);
    try { await fn(); } catch (e) { log.error('shutdown error', { err: e.message }); }
    clearTimeout(t);
    process.exit(0);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

process.on('unhandledRejection', (e) => {
  log.fatal('unhandled rejection', { err: String(e?.message ?? e) });
  process.exit(1);
});
